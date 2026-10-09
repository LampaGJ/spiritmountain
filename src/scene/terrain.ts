import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  type Material,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { applyRadialFade, type RadialFadeUniforms } from './fade';
import { elevationToSceneY, toScene } from './frame';
import type { MeshSurface } from './heightfield';
import { TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR } from './palette';

/**
 * Slope shading window on (1 - normal.y). 0.04 is about 16 degrees and 0.30 about 46 degrees:
 * the range of real ski terrain. Below the lower edge the flat colour is used, above the upper edge the steep colour.
 */
export const SLOPE_SHADE_EDGE_LOW = 0.04;
export const SLOPE_SHADE_EDGE_HIGH = 0.3;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Displaced terrain geometry from a mesh surface. No WebGL needed, so it runs in node tests.
 *
 * PlaneGeometry rows run from +y (top) to -y; rotateX(-PI/2) maps (x, y, 0) to (x, 0, -y), so
 * row 0 lands at the most negative z (north) and a row-major heightfield with row 0 northmost
 * maps onto vertex order with no flipping.
 *
 * Imagery orientation rule (proved in tests/scene/terrain-imagery.test.ts): PlaneGeometry gives vertex
 * row 0 the UV v = 1 and column 0 the UV u = 0, so after rotateX the north-west corner is UV (0, 1).
 * A texture loaded from an image has flipY = true, which puts the image's top row at v = 1 and its left
 * column at u = 0. So an image whose top edge is north and left edge is west drapes with no UV change.
 * The UVs run 0..1 over the MESH box, which spans segX * stepEast = (cols - 1) * cellSize (first to last cell centre). The
 * photo covers the heightfield's pixel-corner box, half a cell wider on every side, so a mesh-box UV squeezes the photo by
 * one cell (5 m over 6950 m, up to 2.5 m at the frame edge; measured in #75). Callers that drape the base photo crop with
 * cropTerrainUvToPhoto (createTerrainMesh does); surface.ts crops its meshes with a texture offset and repeat instead.
 */
export function buildTerrainGeometry(surface: MeshSurface): BufferGeometry {
  const { grid, heights, extent } = surface;
  const geometry = new PlaneGeometry(extent.widthM, extent.heightM, grid.segX, grid.segY);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const array = position.array as Float32Array;
  if (array.length !== heights.length * 3) {
    throw new Error(
      `plane has ${array.length / 3} vertices but the mesh surface has ${heights.length} heights`,
    );
  }
  for (let i = 0; i < heights.length; i += 1) {
    array[i * 3 + 1] = elevationToSceneY(heights[i] as number);
  }
  const centre = toScene(extent.centreEast, extent.centreNorth, 0);
  geometry.translate(centre.x, 0, centre.z);
  geometry.computeVertexNormals();
  applySlopeColors(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Unsharp-mask strength on the photo: c = s0 + k * (s0 - blur), clamped to [0, 1].
 */
export const SHARPEN_AMOUNT = 0.6;
/** Distance in metres from the fade centre (the resort) at which the sharpen amount has fallen to SHARPEN_FAR_FRACTION: about the frame edge. */
export const SHARPEN_FAR_M = 3500;
/** Fraction of SHARPEN_AMOUNT left at SHARPEN_FAR_M and beyond, so the far field does not look crisper than its data. */
export const SHARPEN_FAR_FRACTION = 0.5;
/** World period in metres of the procedural detail noise. */
export const DETAIL_METRES = 2.0;
/** Luminance modulation of the detail noise: colour *= 1 + DETAIL_AMOUNT * (noise - 0.5). */
export const DETAIL_AMOUNT = 0.08;
/** The detail noise is gone beyond this camera distance in metres, so the far field stays clean. */
export const DETAIL_FADE_M = 1500;

const SHARPEN_MARKER = 'imagerySharpen';
const SHARPEN_KEY = 'imagery-sharpen';

/**
 * Patches the terrain material so the photo is sharpened at sample time and carries a faint procedural detail.
 * @displayName Terrain imagery sharpen
 * @strategicPurpose The pinned NAIP is 1.7 m/px and reads soft; a shader filter makes it look crisper with no refetch.
 * @tacticalObjective Replaces map_fragment with an unsharp mask (the blur is the next mip level, one fetch) plus a hash value noise that fades with camera distance.
 *
 * Chains onBeforeCompile and customProgramCacheKey like applyHorizonBlend, so call it AFTER applyRadialFade and BEFORE
 * applyHorizonBlend. Idempotent per material.
 */
export function applyImagerySharpen(material: Material): void {
  if (material.userData[SHARPEN_MARKER]) return;
  material.userData[SHARPEN_MARKER] = true;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSharpenPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSharpenPos = (modelMatrix * vec4(transformed, 1.0)).xz;',
      );
    const declarations = [
      'varying vec2 vSharpenPos;',
      'float sharpenHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
      'float sharpenNoise(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(sharpenHash(i), sharpenHash(i + vec2(1.0, 0.0)), u.x), mix(sharpenHash(i + vec2(0.0, 1.0)), sharpenHash(i + vec2(1.0, 1.0)), u.x), u.y);',
      '}',
    ].join('\n');
    const mapFragment = `#ifdef USE_MAP
{
  vec4 s0 = texture2D(map, vMapUv);
  vec3 blur = texture2D(map, vMapUv, 1.0).rgb;
  float sharpK = ${SHARPEN_AMOUNT.toFixed(2)} * mix(1.0, ${SHARPEN_FAR_FRACTION.toFixed(2)}, smoothstep(0.0, ${SHARPEN_FAR_M.toFixed(1)}, distance(vSharpenPos, fadeCentre)));
  vec3 sharp = clamp(s0.rgb + sharpK * (s0.rgb - blur), 0.0, 1.0);
  float detailFade = 1.0 - smoothstep(${(DETAIL_FADE_M * 0.5).toFixed(1)}, ${DETAIL_FADE_M.toFixed(1)}, distance(vSharpenPos, cameraPosition.xz));
  float detail = sharpenNoise(vSharpenPos / ${DETAIL_METRES.toFixed(1)});
  sharp *= 1.0 + ${DETAIL_AMOUNT.toFixed(2)} * (detail - 0.5) * detailFade;
  diffuseColor *= vec4(clamp(sharp, 0.0, 1.0), s0.a);
}
#endif`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${declarations}`)
      .replace('#include <map_fragment>', mapFragment);
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}+${SHARPEN_KEY}`;
  material.needsUpdate = true;
}

/** Writes a linear-sRGB colour attribute: flat to steep by smoothstep on (1 - normal.y). */
export function applySlopeColors(geometry: BufferGeometry): void {
  const normals = geometry.getAttribute('normal') as BufferAttribute;
  const flat = new Color(TERRAIN_FLAT_COLOR);
  const steep = new Color(TERRAIN_STEEP_COLOR);
  const colors = new Float32Array(normals.count * 3);
  const tmp = new Color();
  for (let i = 0; i < normals.count; i += 1) {
    const t = smoothstep(SLOPE_SHADE_EDGE_LOW, SLOPE_SHADE_EDGE_HIGH, 1 - normals.getY(i));
    tmp.copy(flat).lerp(steep, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
}

/**
 * Swaps the terrain between the photo and slope shading. With a texture the map is shown at full
 * strength and vertex colours are off (they would tint it); with null the slope colours return.
 * The geometry keeps its colour attribute either way, so toggling needs no rebuild.
 */
export function setTerrainImagery(mesh: Mesh, texture: Texture | null): void {
  const material = mesh.material as MeshStandardMaterial;
  material.map = texture;
  material.vertexColors = texture === null;
  material.needsUpdate = true;
}

/**
 * Rewrites a buildTerrainGeometry uv (0..1 over the mesh box) so it addresses the base photo, which covers the
 * heightfield's pixel-corner box: west = first cell centre - cellSizeEast / 2, width = cols * cellSizeEast, and the same
 * north-south. The NAIP export is requested for exactly that box (scripts/ingest/imagery.ts asks for the 3DEP decoded box,
 * which data/terrain.json's corner origin and cell count describe), so after this a vertex samples the pixel it lies in.
 */
export function cropTerrainUvToPhoto(geometry: BufferGeometry, surface: MeshSurface): void {
  const { field, extent } = surface;
  const photoWest = field.originEast - field.cellSizeEast / 2;
  const photoNorth = field.originNorth + field.cellSizeNorth / 2;
  const photoW = field.cols * field.cellSizeEast;
  const photoH = field.rows * field.cellSizeNorth;
  const meshWest = extent.centreEast - extent.widthM / 2;
  const meshSouth = extent.centreNorth - extent.heightM / 2;
  const repeatU = extent.widthM / photoW;
  const repeatV = extent.heightM / photoH;
  const offsetU = (meshWest - photoWest) / photoW;
  const offsetV = (meshSouth - (photoNorth - photoH)) / photoH;
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, offsetU + uv.getX(i) * repeatU, offsetV + uv.getY(i) * repeatV);
  }
  uv.needsUpdate = true;
}

/**
 * Terrain mesh: standard material, slope vertex colours or (when a texture is given) the photo, no shadows.
 * The material fades radially (see applyRadialFade) around a centre that defaults to the mesh centre; the
 * uniforms are kept on mesh.userData.fade so the caller can move the centre to the resort focus box.
 */
export function createTerrainMesh(surface: MeshSurface, texture: Texture | null = null): Mesh {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const fade = applyRadialFade(material, {
    centre: { east: surface.extent.centreEast, north: surface.extent.centreNorth },
  });
  applyImagerySharpen(material);
  const geometry = buildTerrainGeometry(surface);
  cropTerrainUvToPhoto(geometry, surface);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.userData['fade'] = fade;
  setTerrainImagery(mesh, texture);
  return mesh;
}

/** The fade uniforms createTerrainMesh stored on the mesh. */
export function terrainFade(mesh: Mesh): RadialFadeUniforms {
  return mesh.userData['fade'] as RadialFadeUniforms;
}

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { applyRadialFade, type RadialFadeUniforms } from './fade';
import { SHARPEN_AMOUNT } from './terrain';

/** Width in metres of the smoothstep that fades the inset patch in at its rect edges. */
export const INSET_FEATHER_M = 60;

/** The inset's place in local metres (east and north from the frame origin). */
export interface InsetRect {
  readonly minEast: number;
  readonly minNorth: number;
  readonly maxEast: number;
  readonly maxNorth: number;
}

/**
 * The triangles of a terrain geometry whose bounding box touches rect, as a new geometry that shares the terrain's
 * attribute buffers (position, normal, uv, colour) and carries its own index. Sharing the vertices keeps the patch
 * exactly coincident with the terrain, so the two never disagree on depth. East is x and north is minus z.
 */
export function buildInsetGeometry(terrain: BufferGeometry, rect: InsetRect): BufferGeometry {
  const position = terrain.getAttribute('position') as BufferAttribute;
  const index = terrain.index;
  if (!index) throw new Error('the terrain geometry has no index');
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    const east = [position.getX(a), position.getX(b), position.getX(c)];
    const north = [-position.getZ(a), -position.getZ(b), -position.getZ(c)];
    if (
      Math.max(...east) < rect.minEast ||
      Math.min(...east) > rect.maxEast ||
      Math.max(...north) < rect.minNorth ||
      Math.min(...north) > rect.maxNorth
    ) {
      continue;
    }
    kept.push(a, b, c);
  }
  if (kept.length === 0) throw new Error('the inset rect does not touch the terrain');
  const geometry = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const attribute = terrain.getAttribute(name);
    if (attribute) geometry.setAttribute(name, attribute);
  }
  geometry.setIndex(new BufferAttribute(Uint32Array.from(kept), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The uniforms the inset shader reads. */
export interface InsetPatchUniforms {
  uInsetRect: IUniform<Vector4>;
  uInsetFeather: IUniform<number>;
}

/**
 * Patches a material whose `map` is the inset photo: the colour comes from the inset at the fragment's plan position
 * (rect-relative uv, so the geometry's own uv is unused), sharpened with the same unsharp mask as the base photo, and
 * the alpha falls to zero at the rect edge over INSET_FEATHER_M so the patch blends into the terrain under it.
 *
 * Why a separate patch and not a second sampler in the terrain shader: the terrain program already makes two map
 * fetches plus the horizon blend's two sky fetches, and a third map-side fetch made the sky background render
 * posterized in headless Chrome on Metal. This program has the same two map fetches as the terrain's, so it stays inside
 * that envelope. Call it AFTER applyRadialFade (it wraps that patch) and BEFORE applyHorizonBlend.
 */
export function applyInsetPatch(
  material: MeshStandardMaterial,
  rect: InsetRect,
): InsetPatchUniforms {
  const uniforms: InsetPatchUniforms = {
    uInsetRect: { value: new Vector4(rect.minEast, rect.minNorth, rect.maxEast, rect.maxNorth) },
    uInsetFeather: { value: INSET_FEATHER_M },
  };
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms['uInsetRect'] = uniforms.uInsetRect;
    shader.uniforms['uInsetFeather'] = uniforms.uInsetFeather;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vInsetPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvInsetPos = (modelMatrix * vec4(transformed, 1.0)).xz;',
      );
    const mapFragment = `#ifdef USE_MAP
{
  // Scene x is east and z is minus north (src/scene/frame.ts:35); the inset is north-up, so flipY keeps v = 1 at its top row.
  vec2 insetEN = vec2(vInsetPos.x, -vInsetPos.y);
  vec2 insetUv = (insetEN - uInsetRect.xy) / (uInsetRect.zw - uInsetRect.xy);
  vec2 insetEdge = min(insetEN - uInsetRect.xy, uInsetRect.zw - insetEN);
  vec4 s0 = texture2D(map, insetUv);
  vec3 blur = texture2D(map, insetUv, 1.0).rgb;
  vec3 sharp = clamp(s0.rgb + ${SHARPEN_AMOUNT.toFixed(2)} * (s0.rgb - blur), 0.0, 1.0);
  diffuseColor *= vec4(sharp, smoothstep(0.0, uInsetFeather, min(insetEdge.x, insetEdge.y)));
}
#endif`;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vInsetPos;\nuniform vec4 uInsetRect;\nuniform float uInsetFeather;',
      )
      .replace('#include <map_fragment>', mapFragment);
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}+inset-patch`;
  material.needsUpdate = true;
  return uniforms;
}

export interface InsetPatch {
  readonly mesh: Mesh;
  readonly material: MeshStandardMaterial;
  /** The patch's own radial-fade uniforms; move them with the terrain's. */
  readonly fade: RadialFadeUniforms;
}

/**
 * Terrain-coincident mesh that shows the native-resolution inset over the base photo inside rect.
 * Drawn after the terrain, no depth write, so the base photo shows through the feathered edge.
 */
export function createInsetPatch(
  terrain: Mesh,
  texture: Texture,
  rect: InsetRect,
  fadeOf: RadialFadeUniforms,
): InsetPatch {
  const material = new MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
  const centre = fadeOf.fadeCentre.value;
  const fade = applyRadialFade(material, {
    // fadeCentre holds [east, minus north].
    centre: { east: centre[0], north: -centre[1] },
    innerM: fadeOf.fadeInner.value,
    outerM: fadeOf.fadeOuter.value,
  });
  applyInsetPatch(material, rect);
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  const mesh = new Mesh(buildInsetGeometry(terrain.geometry, rect), material);
  mesh.name = 'terrain-inset';
  mesh.renderOrder = terrain.renderOrder + 1;
  // The terrain mesh is the one pick target; the patch only paints.
  mesh.raycast = () => {};
  return { mesh, material, fade };
}

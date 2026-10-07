import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
} from 'three';
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
 * The NAIP export is requested for the heightfield's own box, so image edges equal mesh edges. The plane spans segX * stepEast = (cols - 1) * cellSize
 * (cell-centre samples), so its edges coincide with the first and last sample.
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

/** Terrain mesh: standard material, slope vertex colours or (when a texture is given) the photo, no shadows. */
export function createTerrainMesh(surface: MeshSurface, texture: Texture | null = null): Mesh {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new Mesh(buildTerrainGeometry(surface), material);
  mesh.name = 'terrain';
  setTerrainImagery(mesh, texture);
  return mesh;
}

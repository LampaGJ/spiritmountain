import { Color, Mesh, MeshStandardMaterial, PlaneGeometry, type ColorRepresentation } from 'three';
import { elevationToSceneY, toScene } from './frame';
import { TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR } from './palette';

/** Side of the ground plane in metres; well past the fade outer radius. */
export const GROUND_SIZE_M = 60_000;
/** The plane sits this far (scene metres) under the lake level so it never z-fights the terrain's lowest cells. */
export const GROUND_DROP_M = 0.5;

/** Mid slope-shading colour (flat and steep palette midpoint): the ground tint when imagery is off. */
export function groundSlopeColor(): Color {
  return new Color(TERRAIN_FLAT_COLOR).lerp(new Color(TERRAIN_STEEP_COLOR), 0.5);
}

/**
 * Flat plane under and beyond the terrain, in the photo's mean colour, so the faded edge of the terrain and
 * context ring blends into ground instead of sky. Opaque, drawn first (renderOrder -1), no fade, no shadows.
 */
export function createGround(
  color: ColorRepresentation,
  baseElevationM: number,
  centre: { readonly east: number; readonly north: number } = { east: 0, north: 0 },
): Mesh {
  const material = new MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const mesh = new Mesh(new PlaneGeometry(GROUND_SIZE_M, GROUND_SIZE_M), material);
  mesh.name = 'ground';
  mesh.rotation.x = -Math.PI / 2;
  const p = toScene(centre.east, centre.north, 0);
  mesh.position.set(p.x, elevationToSceneY(baseElevationM) - GROUND_DROP_M, p.z);
  mesh.renderOrder = -1;
  mesh.receiveShadow = false;
  return mesh;
}

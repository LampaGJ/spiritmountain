/**
 * The one place where the local metre frame (x east, y north, elevation separate; from #8 and #9)
 * is mapped to three.js axes. Every later issue (#12 to #14) places geometry through these functions.
 *
 * Mapping: scene x = east, scene y = elevation * VERTICAL_EXAGGERATION, scene z = -north.
 * z grows toward the south, so a camera at positive z looks north.
 */

/** Vertical exaggeration applied to every elevation. Appears nowhere else under src/. */
export const VERTICAL_EXAGGERATION = 1;

export interface ScenePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface LocalPoint {
  readonly east: number;
  readonly north: number;
  readonly elevation: number;
}

/** Scene y for an elevation in metres. */
export function elevationToSceneY(elevation: number): number {
  return elevation * VERTICAL_EXAGGERATION;
}

/** Elevation in metres for a scene y. */
export function sceneYToElevation(y: number): number {
  return y / VERTICAL_EXAGGERATION;
}

/** Local metres (east, north, elevation) to a three.js position. */
export function toScene(east: number, north: number, elevation: number): ScenePoint {
  return { x: east, y: elevationToSceneY(elevation), z: -north };
}

/** Inverse of toScene. */
export function fromScene(x: number, y: number, z: number): LocalPoint {
  return { east: x, north: -z, elevation: sceneYToElevation(y) };
}

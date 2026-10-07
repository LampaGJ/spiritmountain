import { Group, type PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Smallest scale applied to the group. A scale of exactly 0 makes the world matrix singular
 * (NaN normals, a raycaster that cannot invert it), so k = 0 is drawn as 0.1 percent of the relief:
 * flat to the eye, still a valid transform.
 */
export const MIN_SCALE_Y = 0.1;

/** Scale actually used for an exaggeration factor k. */
export const effectiveScale = (k: number): number => Math.max(k, MIN_SCALE_Y);

/** The vertical map about the base line: y' = base + k * (y - base). The base (lake level) never moves. */
export function mapY(y: number, k: number, base: number): number {
  return base + k * (y - base);
}

/**
 * The one scene group that holds every object whose y encodes elevation. Scaling it about the lake line is the whole
 * feature: geometry is never rebuilt. The ground plane and sky stay outside it.
 */
export class ElevatedGroup extends Group {
  constructor() {
    super();
    this.name = 'elevated';
  }

  /** scale.y = k and position.y = base * (1 - k), so a point at y lands at mapY(y, k, base). */
  setExaggeration(k: number, baseSceneY: number): void {
    const s = effectiveScale(k);
    this.scale.y = s;
    this.position.y = baseSceneY * (1 - s);
    this.updateMatrixWorld(true);
  }
}

/**
 * Carries the camera and the orbit target through the same affine map when k changes from k0 to k1,
 * so the view keeps its framing relative to the terrain. Lossy only when k0 is 0 (the height above the lake was squashed away).
 */
export function remapCamera(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  k0: number,
  k1: number,
  base: number,
): void {
  const ratio = effectiveScale(k1) / effectiveScale(k0);
  camera.position.y = mapY(camera.position.y, ratio, base);
  controls.target.y = mapY(controls.target.y, ratio, base);
}

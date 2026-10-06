import { Box3, Sphere, Vector3 } from 'three';
import { elevationToSceneY, fromScene, toScene } from './frame';
import type { Heightfield, MeshSurface } from './heightfield';

/** Named camera views. #13 and #14 call handle.setView(name) with one of these. */
export const NAMED_VIEWS = ['overview', 'topdown', 'summit-south'] as const;
export type ViewName = (typeof NAMED_VIEWS)[number];

export interface CameraView {
  readonly position: Vector3;
  readonly target: Vector3;
  readonly up: Vector3;
}

export interface ViewSet {
  readonly views: Record<ViewName, CameraView>;
  /** Scene-space bounds of the displaced terrain. */
  readonly box: Box3;
  readonly sphere: Sphere;
  readonly near: number;
  readonly far: number;
}

/** Vertical field of view in degrees; computeViews and the camera must agree. */
export const CAMERA_FOV_DEG = 50;
/** Overview camera: elevation angle above the horizon, and azimuth west of south. */
export const OVERVIEW_ELEVATION_DEG = 40;
export const OVERVIEW_AZIMUTH_WEST_OF_SOUTH_DEG = 22.5;
/** Summit view: how far south and how high above the summit, as fractions of the terrain's bounding radius. */
export const SUMMIT_VIEW_SOUTH_FRACTION = 0.2;
export const SUMMIT_VIEW_UP_FRACTION = 0.06;
/** The camera is never allowed lower than this many metres above the terrain surface beneath it. */
export const CAMERA_CLEARANCE_M = 5;

export interface Summit {
  readonly col: number;
  readonly row: number;
  readonly elevation: number;
  readonly east: number;
  readonly north: number;
}

/** Highest heightfield cell; ties go to the first in row-major order, so the result is deterministic. */
export function findSummit(field: Heightfield): Summit {
  let best = 0;
  let bestValue = field.data[0] as number;
  for (let i = 1; i < field.data.length; i += 1) {
    const value = field.data[i] as number;
    if (value > bestValue) {
      best = i;
      bestValue = value;
    }
  }
  const col = best % field.cols;
  const row = Math.floor(best / field.cols);
  return {
    col,
    row,
    elevation: bestValue,
    east: field.originEast + col * field.cellSizeEast,
    north: field.originNorth - row * field.cellSizeNorth,
  };
}

/** Scene-space bounding box of the terrain mesh, from the surface extent and its height range. */
export function terrainBox(surface: MeshSurface): Box3 {
  let min = Infinity;
  let max = -Infinity;
  for (const h of surface.heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const { extent } = surface;
  const a = toScene(
    extent.centreEast - extent.widthM / 2,
    extent.centreNorth - extent.heightM / 2,
    min,
  );
  const b = toScene(
    extent.centreEast + extent.widthM / 2,
    extent.centreNorth + extent.heightM / 2,
    max,
  );
  return new Box3().setFromPoints([new Vector3(a.x, a.y, a.z), new Vector3(b.x, b.y, b.z)]);
}

/** Camera positions come from the terrain extent, never from hard-coded metres. */
export function computeViews(surface: MeshSurface, aspect: number): ViewSet {
  const box = terrainBox(surface);
  const sphere = box.getBoundingSphere(new Sphere());
  const centre = sphere.center;
  const halfV = (CAMERA_FOV_DEG / 2) * (Math.PI / 180);
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const fitDistance = sphere.radius / Math.sin(Math.min(halfV, halfH));

  const elev = OVERVIEW_ELEVATION_DEG * (Math.PI / 180);
  const azim = OVERVIEW_AZIMUTH_WEST_OF_SOUTH_DEG * (Math.PI / 180);
  const dir = new Vector3(
    -Math.sin(azim) * Math.cos(elev),
    Math.sin(elev),
    Math.cos(azim) * Math.cos(elev),
  );
  const overview: CameraView = {
    position: centre.clone().addScaledVector(dir, fitDistance),
    target: centre.clone(),
    up: new Vector3(0, 1, 0),
  };
  // North (negative z) is up the screen: the camera's up vector points north.
  const topdown: CameraView = {
    position: new Vector3(centre.x, centre.y + fitDistance, centre.z),
    target: centre.clone(),
    up: new Vector3(0, 0, -1),
  };

  const summit = findSummit(surface.field);
  const s = toScene(summit.east, summit.north, summit.elevation);
  const summitTarget = new Vector3(s.x, s.y, s.z);
  const summitSouth: CameraView = {
    position: new Vector3(
      s.x,
      s.y + SUMMIT_VIEW_UP_FRACTION * sphere.radius,
      s.z + SUMMIT_VIEW_SOUTH_FRACTION * sphere.radius,
    ),
    target: summitTarget,
    up: new Vector3(0, 1, 0),
  };

  const far = fitDistance + 2 * sphere.radius;
  const near = Math.max(1, far / 5000);
  return { views: { overview, topdown, 'summit-south': summitSouth }, box, sphere, near, far };
}

/** Lowest allowed scene y for a camera at scene (x, z): terrain surface plus CAMERA_CLEARANCE_M. */
export function minCameraY(surface: MeshSurface, x: number, z: number): number {
  const { east, north } = fromScene(x, 0, z);
  return elevationToSceneY(surface.sample(east, north).height) + CAMERA_CLEARANCE_M;
}

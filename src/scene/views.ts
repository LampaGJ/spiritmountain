import { Box3, Sphere, Vector3 } from 'three';
import { mapY } from './elevated';
import { elevationToSceneY, fromScene, toScene } from './frame';
import type { AreaEntry } from './areas';
import type { Heightfield, MeshSurface } from './heightfield';

/** Named camera views. #13 and #14 call handle.setView(name) with one of these. */
export const NAMED_VIEWS = ['overview', 'topdown', 'summit-south', 'resort'] as const;
export type ViewName = (typeof NAMED_VIEWS)[number];

export interface CameraView {
  readonly position: Vector3;
  readonly target: Vector3;
  readonly up: Vector3;
  /** Landmark resort view only: straight-line metres from the camera to the target after fitting. */
  readonly distance?: number;
}

/** Far over near: 24-bit depth stays usable for a 1 m line lift at 5 km with this ratio; the live far plane keeps it too. */
export const NEAR_FAR_RATIO = 5000;

export interface ViewSet {
  readonly views: Record<ViewName, CameraView>;
  /** Scene-space bounds of the displaced terrain. */
  readonly box: Box3;
  readonly sphere: Sphere;
  readonly near: number;
  readonly far: number;
  /** Vertical fov in degrees for the aspect computeViews was given. */
  readonly fov: number;
}

/** Horizontal field of view in degrees (principal: a 2 m tall person with 120 degree horizontal perspective). */
export const HORIZONTAL_FOV_DEG = 120;
/** Vertical fov bounds in degrees: a portrait phone never gets a 120-plus degree vertical field; a squarer viewport never a sliver. */
export const MIN_VERTICAL_FOV_DEG = 50;
export const MAX_VERTICAL_FOV_DEG = 95;
/** three.js cameras take a VERTICAL fov; derive it from the horizontal one and the viewport aspect. */
export function verticalFovDeg(aspect: number): number {
  const halfH = (HORIZONTAL_FOV_DEG / 2) * (Math.PI / 180);
  const raw = (2 * Math.atan(Math.tan(halfH) / Math.max(aspect, 0.1)) * 180) / Math.PI;
  return Math.min(Math.max(raw, MIN_VERTICAL_FOV_DEG), MAX_VERTICAL_FOV_DEG);
}
/** Vertical fov at a 16:9 viewport; the camera is constructed with this and should be retuned per aspect. */
export const CAMERA_FOV_DEG = verticalFovDeg(16 / 9);
/** Overview camera: elevation angle above the horizon, and azimuth west of south. */
export const OVERVIEW_ELEVATION_DEG = 40;
export const OVERVIEW_AZIMUTH_WEST_OF_SOUTH_DEG = 22.5;
/** Summit view: how far south and how high above the summit, as fractions of the terrain's bounding radius. */
export const SUMMIT_VIEW_SOUTH_FRACTION = 0.2;
export const SUMMIT_VIEW_UP_FRACTION = 0.06;
/** The camera is never allowed lower than this many metres above the terrain surface beneath it. */
export const CAMERA_CLEARANCE_M = 2;

/** Resort view distance, as a multiple of the focus box diagonal, before clamping. */
export const RESORT_VIEW_DISTANCE_FACTOR = 1.0;
/** Resort view horizontal distance is never closer than this, in metres. */
export const RESORT_VIEW_MIN_DISTANCE_M = 700;
/** Resort view horizontal distance is never farther than this, in metres. */
export const RESORT_VIEW_MAX_DISTANCE_M = 2500;
/** Resort camera height above the terrain beneath it, as a fraction of the view distance. */
export const RESORT_VIEW_HEIGHT_FRACTION = 0;
/** Resort camera height above the terrain beneath it never falls below this, in metres. */
export const RESORT_VIEW_MIN_HEIGHT_M = 2;
/** Resort target sits this fraction of the focus box's height range above its lowest sampled point, so it reads as mid-slope. */
export const RESORT_TARGET_SLOPE_FRACTION = 0.35;
/**
 * The resort camera's view direction is never flatter than this many degrees below horizontal.
 * Added to the specified construction: on the real resort the base-side camera sits at target height
 * (measured -0.1 degrees), so without a floor the view is level and shows no slope.
 */
export const RESORT_VIEW_MIN_ELEVATION_DEG = -30;
/** The resort camera stands this far beyond the lift base, away from the lift top, in metres (the parking lot). */
export const RESORT_LANDMARK_BACK_OFF_M = 60;
/** Roof height assumed for the Upper Chalet when the data gives none, in metres. */
export const RESORT_LANDMARK_DEFAULT_ROOF_M = 8;
/** Fraction of each half-angle the chalet and lift top may occupy; the rest is the 10 percent margin. */
export const RESORT_FIT_FRAME_FRACTION = 0.9;
/** The fit never moves the camera back further than this multiple of its base-lot distance from the target. */
export const RESORT_FIT_MAX_DISTANCE_FACTOR = 2.5;
/** Metres the fit steps the camera back per iteration. */
export const RESORT_FIT_STEP_M = 10;
/** With no focus box, the resort view uses a box of this half-size around the summit, in metres. */
export const RESORT_FALLBACK_HALF_SIZE_M = 400;

/** Axis-aligned box in local metres (east, north). */
export interface FocusBox {
  readonly minEast: number;
  readonly maxEast: number;
  readonly minNorth: number;
  readonly maxNorth: number;
}

/** A point in local metres. */
export interface EastNorth {
  readonly east: number;
  readonly north: number;
}

/**
 * Landmarks that pin the default resort view: the camera stands just below the main lift's base,
 * looking up the lift at the Upper Chalet. Without upperChalet the target falls back to the focus-box centre.
 */
export interface Landmarks {
  readonly liftBase: EastNorth;
  readonly liftTop: EastNorth;
  readonly upperChalet?: EastNorth & { readonly roofM?: number };
}

const FOCUS_KINDS: ReadonlySet<string> = new Set(['downhill-run', 'lift']);

/** Bounding box of every downhill-run and lift coordinate, or null when there are none. */
export function focusBoxOf(entries: Iterable<Pick<AreaEntry, 'area'>>): FocusBox | null {
  let minEast = Infinity;
  let maxEast = -Infinity;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  const visit = (position: readonly number[]): void => {
    const east = position[0] as number;
    const north = position[1] as number;
    if (east < minEast) minEast = east;
    if (east > maxEast) maxEast = east;
    if (north < minNorth) minNorth = north;
    if (north > maxNorth) maxNorth = north;
  };
  for (const { area } of entries) {
    if (!FOCUS_KINDS.has(area.kind)) continue;
    const { geometry } = area;
    if (geometry.type === 'LineString') geometry.coordinates.forEach(visit);
    else geometry.coordinates.forEach((ring) => ring.forEach(visit));
  }
  return minEast === Infinity ? null : { minEast, maxEast, minNorth, maxNorth };
}

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
export function computeViews(
  surface: MeshSurface,
  aspect: number,
  focus?: FocusBox,
  landmarks?: Landmarks,
): ViewSet {
  const box = terrainBox(surface);
  const sphere = box.getBoundingSphere(new Sphere());
  const centre = sphere.center;
  const fov = verticalFovDeg(aspect);
  const halfV = (fov / 2) * (Math.PI / 180);
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

  const resort = resortView(
    surface,
    focus ?? {
      minEast: summit.east - RESORT_FALLBACK_HALF_SIZE_M,
      maxEast: summit.east + RESORT_FALLBACK_HALF_SIZE_M,
      minNorth: summit.north - RESORT_FALLBACK_HALF_SIZE_M,
      maxNorth: summit.north + RESORT_FALLBACK_HALF_SIZE_M,
    },
    landmarks,
    fov,
    aspect,
  );

  const far = fitDistance + 2 * sphere.radius;
  const near = Math.max(1, far / NEAR_FAR_RATIO);
  return {
    views: { overview, topdown, 'summit-south': summitSouth, resort },
    box,
    sphere,
    near,
    far,
    fov,
  };
}

/**
 * Resort view: target mid-slope at the focus box centre, camera on the base side (the lowest edge
 * midpoint) looking uphill, low and far enough back to read true-scale verticality.
 */
function resortView(
  surface: MeshSurface,
  focus: FocusBox,
  landmarks: Landmarks | undefined,
  fov: number,
  aspect: number,
): CameraView {
  const centreEast = (focus.minEast + focus.maxEast) / 2;
  const centreNorth = (focus.minNorth + focus.maxNorth) / 2;
  const height = (east: number, north: number): number => surface.sample(east, north).height;

  const southMid = { east: centreEast, north: focus.minNorth };
  const northMid = { east: centreEast, north: focus.maxNorth };
  const westMid = { east: focus.minEast, north: centreNorth };
  const eastMid = { east: focus.maxEast, north: centreNorth };
  const mids = [southMid, northMid, westMid, eastMid];
  const corners = [
    [focus.minEast, focus.minNorth],
    [focus.minEast, focus.maxNorth],
    [focus.maxEast, focus.minNorth],
    [focus.maxEast, focus.maxNorth],
  ] as const;
  const centreHeight = height(centreEast, centreNorth);
  const sampled = [centreHeight, ...corners.map(([e, n]) => height(e, n))];
  const range = Math.max(...sampled) - Math.min(...sampled);
  const t = toScene(centreEast, centreNorth, centreHeight + RESORT_TARGET_SLOPE_FRACTION * range);
  const target = new Vector3(t.x, t.y, t.z);

  if (landmarks) {
    const view = landmarkView(surface, landmarks, target, fov, aspect);
    if (view) return view;
  }

  const lowest = mids.reduce((a, b) => (height(b.east, b.north) < height(a.east, a.north) ? b : a));
  // Scene z is -north. A flat box has no base side; fall back to south, the overview's side.
  let sideX = lowest.east - centreEast;
  let sideZ = -(lowest.north - centreNorth);
  const sideLength = Math.hypot(sideX, sideZ);
  if (sideLength === 0) {
    sideX = 0;
    sideZ = 1;
  } else {
    sideX /= sideLength;
    sideZ /= sideLength;
  }

  const diagonal = Math.hypot(focus.maxEast - focus.minEast, focus.maxNorth - focus.minNorth);
  const distance = Math.min(
    Math.max(RESORT_VIEW_DISTANCE_FACTOR * diagonal, RESORT_VIEW_MIN_DISTANCE_M),
    RESORT_VIEW_MAX_DISTANCE_M,
  );
  const x = target.x + sideX * distance;
  const z = target.z + sideZ * distance;
  const ground = fromScene(x, 0, z);
  const aboveGround =
    elevationToSceneY(height(ground.east, ground.north)) +
    Math.max(RESORT_VIEW_MIN_HEIGHT_M, RESORT_VIEW_HEIGHT_FRACTION * distance);
  const elevationFloor =
    target.y + Math.tan((RESORT_VIEW_MIN_ELEVATION_DEG * Math.PI) / 180) * distance;
  const y = Math.max(aboveGround, minCameraY(surface, x, z), elevationFloor);
  return { position: new Vector3(x, y, z), target, up: new Vector3(0, 1, 0) };
}

/**
 * Landmark resort view: the camera stands RESORT_LANDMARK_BACK_OFF_M beyond the lift base, away from the lift top,
 * at eye height above the terrain there; the target is the Upper Chalet at half its roof height (or fallbackTarget).
 * Null when base and top coincide, since the lift then gives no direction.
 */
function landmarkView(
  surface: MeshSurface,
  { liftBase, liftTop, upperChalet }: Landmarks,
  fallbackTarget: Vector3,
  fovDeg: number,
  aspect: number,
): CameraView | null {
  const dEast = liftBase.east - liftTop.east;
  const dNorth = liftBase.north - liftTop.north;
  const length = Math.hypot(dEast, dNorth);
  if (length === 0) return null;
  const eyeAt = (east: number, north: number): Vector3 => {
    const eye = toScene(east, north, surface.sample(east, north).height);
    return new Vector3(eye.x, eye.y + CAMERA_CLEARANCE_M, eye.z);
  };
  const east0 = liftBase.east + (dEast / length) * RESORT_LANDMARK_BACK_OFF_M;
  const north0 = liftBase.north + (dNorth / length) * RESORT_LANDMARK_BACK_OFF_M;
  let position = eyeAt(east0, north0);
  let target = fallbackTarget;
  if (upperChalet) {
    const roofM = upperChalet.roofM ?? RESORT_LANDMARK_DEFAULT_ROOF_M;
    const t = toScene(
      upperChalet.east,
      upperChalet.north,
      surface.sample(upperChalet.east, upperChalet.north).height + roofM / 2,
    );
    target = new Vector3(t.x, t.y, t.z);
  }
  const up = new Vector3(0, 1, 0);

  // Fit: the lift top must sit inside the frame (with a margin) as seen from the chosen position; if not,
  // back the camera off along the horizontal sight line, never beyond RESORT_FIT_MAX_DISTANCE_FACTOR.
  const topScene = toScene(
    liftTop.east,
    liftTop.north,
    surface.sample(liftTop.east, liftTop.north).height,
  );
  const points = [target, new Vector3(topScene.x, topScene.y, topScene.z)];
  const halfV = (fovDeg / 2) * (Math.PI / 180);
  const tanV = Math.tan(halfV) * RESORT_FIT_FRAME_FRACTION;
  const tanH = Math.tan(halfV) * aspect * RESORT_FIT_FRAME_FRACTION;
  const fits = (from: Vector3): boolean => {
    const forward = target.clone().sub(from).normalize();
    const right = new Vector3().crossVectors(forward, up).normalize();
    const camUp = new Vector3().crossVectors(right, forward);
    return points.every((point) => {
      const rel = point.clone().sub(from);
      const depth = rel.dot(forward);
      return (
        depth > 0 &&
        Math.abs(rel.dot(right)) <= depth * tanH &&
        Math.abs(rel.dot(camUp)) <= depth * tanV
      );
    });
  };
  const toTarget = { x: target.x - position.x, z: target.z - position.z };
  const baseHorizontal = Math.hypot(toTarget.x, toTarget.z);
  if (baseHorizontal > 0) {
    const ux = toTarget.x / baseHorizontal;
    const uz = toTarget.z / baseHorizontal;
    const origin = position;
    const maxBack = (RESORT_FIT_MAX_DISTANCE_FACTOR - 1) * baseHorizontal;
    for (let back = 0; !fits(position) && back < maxBack;) {
      back = Math.min(back + RESORT_FIT_STEP_M, maxBack);
      const local = fromScene(origin.x - ux * back, 0, origin.z - uz * back);
      position = eyeAt(local.east, local.north);
    }
  }
  return { position, target, up, distance: position.distanceTo(target) };
}

/** The live vertical map (see elevated.ts): scene y' = base + k * (y - base). */
export interface ExaggerationMap {
  readonly k: number;
  readonly base: number;
}

/**
 * Lowest allowed scene y for a camera at scene (x, z): the terrain surface as drawn plus CAMERA_CLEARANCE_M.
 * With an exaggeration the sampled height goes through the same map as the drawn terrain, then the clearance is added.
 */
export function minCameraY(
  surface: MeshSurface,
  x: number,
  z: number,
  exaggeration?: ExaggerationMap,
): number {
  const { east, north } = fromScene(x, 0, z);
  const y = elevationToSceneY(surface.sample(east, north).height);
  const drawn = exaggeration ? mapY(y, exaggeration.k, exaggeration.base) : y;
  return drawn + CAMERA_CLEARANCE_M;
}

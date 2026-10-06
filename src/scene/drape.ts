/**
 * Pure draping functions. No three.js import, so everything here unit tests in node.
 * All values are world metres BEFORE vertical exaggeration. Exaggeration is applied once,
 * by the SceneMapper passed to areas.ts, after the lift offsets below have been added.
 */
import type { MeshSurface } from './heightfield';

/** East, north, elevation in world metres. */
export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** Lift of every draped line above the mesh surface, so lines do not z-fight with the terrain. */
export const DRAPE_LIFT_M = 0.5;

/** Longest horizontal step between line vertices after densifying. */
export const MAX_STEP_M = 10;

/**
 * Cable height above ground per OSM aerialway value, for the four measured lift types.
 * Display-only, not surveyed: a rendering constant, not a world fact.
 * Applied in world metres before vertical exaggeration.
 */
export const LIFT_OFFSET_M = {
  chair_lift: 8,
  drag_lift: 1.5,
  rope_tow: 1.5,
  magic_carpet: 0.3,
} as const;
export type LiftType = keyof typeof LIFT_OFFSET_M;

/**
 * Cable height for every other aerialway value #8 maps to kind lift (mixed_lift, gondola, cable_car,
 * t-bar, j-bar, platter). Display-only, not surveyed. A default, not a table, so #8's list needs no
 * mirror here.
 */
export const LIFT_DEFAULT_OFFSET_M = 8;

/** Cable offset for a lift area. Throws, naming the area, only when osmTags.aerialway is missing. */
export function liftOffsetM(areaId: string, osmTags: Readonly<Record<string, string>>): number {
  const type = osmTags['aerialway'];
  if (type === undefined) {
    throw new Error(`area ${areaId}: lift has no aerialway tag`);
  }
  return Object.hasOwn(LIFT_OFFSET_M, type)
    ? LIFT_OFFSET_M[type as LiftType]
    : LIFT_DEFAULT_OFFSET_M;
}

/**
 * Insert evenly spaced points so no step exceeds maxStepM, in the horizontal plane.
 * Original vertices are kept. A zero-length step adds no point.
 */
export function densify(points: ReadonlyArray<Readonly<Vec2>>, maxStepM = MAX_STEP_M): Vec2[] {
  const first = points[0];
  if (first === undefined) return [];
  const out: Vec2[] = [[first[0], first[1]]];
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1] as Readonly<Vec2>;
    const b = points[k] as Readonly<Vec2>;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    const pieces = Math.max(1, Math.ceil(length / maxStepM - 1e-9));
    for (let p = 1; p < pieces; p += 1) {
      const t = p / pieces;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
    out.push([b[0], b[1]]);
  }
  return out;
}

/**
 * Split a polyline wherever a segment crosses a mesh grid line or a mesh cell diagonal, so every
 * piece lies inside one triangle. A line whose vertices sit on the mesh then lies on the mesh.
 * In mesh-cell coordinates (u east, v south) the grid lines are u = k and v = k and the diagonals
 * (south-west to north-east) are u + v = k, for integer k.
 */
export function splitAtMeshEdges(
  surface: MeshSurface,
  points: ReadonlyArray<Readonly<Vec2>>,
): Vec2[] {
  const first = points[0];
  if (first === undefined) return [];
  const { segX, segY } = surface.grid;
  const out: Vec2[] = [[first[0], first[1]]];
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1] as Readonly<Vec2>;
    const b = points[k] as Readonly<Vec2>;
    const ua = surface.toMeshUV(a[0], a[1]);
    const ub = surface.toMeshUV(b[0], b[1]);
    const ts: number[] = [];
    const addCrossings = (f0: number, f1: number, lo: number, hi: number): void => {
      if (f0 === f1) return;
      const from = Math.max(lo, Math.floor(Math.min(f0, f1)) + 1);
      const to = Math.min(hi, Math.ceil(Math.max(f0, f1)) - 1);
      for (let n = from; n <= to; n += 1) ts.push((n - f0) / (f1 - f0));
    };
    addCrossings(ua.u, ub.u, 0, segX);
    addCrossings(ua.v, ub.v, 0, segY);
    addCrossings(ua.u + ua.v, ub.u + ub.v, 0, segX + segY);
    ts.sort((x, y) => x - y);
    let previous = 0;
    for (const t of ts) {
      if (t <= previous + 1e-12 || t >= 1 - 1e-12) continue;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      previous = t;
    }
    out.push([b[0], b[1]]);
  }
  return out;
}

export interface Polyline3 {
  readonly points: Vec3[];
  /** Number of points whose horizontal position was outside the mesh and was clamped. */
  readonly clampedCount: number;
}

function finiteOrThrow(height: number, east: number, north: number): number {
  if (!Number.isFinite(height)) throw new Error(`non-finite terrain height at ${east}, ${north}`);
  return height;
}

/**
 * Drape a line on the mesh surface: split at mesh edges, densify to maxStepM, then set each
 * point to the mesh height plus liftM. Only the horizontal part of each input position is used.
 */
export function drapeLine(
  surface: MeshSurface,
  positions: ReadonlyArray<ReadonlyArray<number>>,
  maxStepM = MAX_STEP_M,
  liftM = DRAPE_LIFT_M,
): Polyline3 {
  const flat = positions.map((p): Vec2 => [p[0] as number, p[1] as number]);
  const dense = densify(splitAtMeshEdges(surface, flat), maxStepM);
  let clampedCount = 0;
  const points = dense.map(([east, north]): Vec3 => {
    const s = surface.sample(east, north);
    if (s.clamped) clampedCount += 1;
    return [east, north, finiteOrThrow(s.height, east, north) + liftM];
  });
  return { points, clampedCount };
}

/**
 * A lift cable: a straight segment between consecutive vertices, each vertex raised to the mesh
 * height plus offsetM. Not draped and not densified.
 */
export function cableLine(
  surface: MeshSurface,
  positions: ReadonlyArray<ReadonlyArray<number>>,
  offsetM: number,
): Polyline3 {
  let clampedCount = 0;
  const points = positions.map((p): Vec3 => {
    const east = p[0] as number;
    const north = p[1] as number;
    const s = surface.sample(east, north);
    if (s.clamped) clampedCount += 1;
    return [east, north, finiteOrThrow(s.height, east, north) + offsetM];
  });
  return { points, clampedCount };
}

/**
 * Smallest vertical clearance of a straight-segment polyline above the mesh, checked at every
 * vertex and at stepM spacing along every segment. Negative means the line passes below ground.
 */
export function minClearance(
  surface: MeshSurface,
  points: ReadonlyArray<Readonly<Vec3>>,
  stepM = 1,
): number {
  const first = points[0];
  if (first === undefined) return Number.POSITIVE_INFINITY;
  let min = first[2] - surface.sample(first[0], first[1]).height;
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1] as Readonly<Vec3>;
    const b = points[k] as Readonly<Vec3>;
    const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepM));
    for (let p = 1; p <= pieces; p += 1) {
      const t = p / pieces;
      const east = a[0] + t * (b[0] - a[0]);
      const north = a[1] + t * (b[1] - a[1]);
      min = Math.min(min, a[2] + t * (b[2] - a[2]) - surface.sample(east, north).height);
    }
  }
  return min;
}

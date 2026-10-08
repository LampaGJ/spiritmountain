/**
 * Pure draping functions. No three.js import, so everything here unit tests in node.
 * All values are world metres BEFORE vertical exaggeration. Exaggeration is applied once,
 * by the SceneMapper passed to areas.ts, after the lift offsets below have been added.
 */
import { edgeSurfacesOf, type MeshSurface } from './heightfield';

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
 *
 * splitAtAllMeshEdges does this for every layer of a composite surface in turn (each pass only adds points), so a line
 * draped on the LiDAR canopy lies on the canopy mesh's own triangles (#36).
 */
export function splitAtAllMeshEdges(
  surface: MeshSurface,
  points: ReadonlyArray<Readonly<Vec2>>,
): Vec2[] {
  let out: Vec2[] = points.map((p) => [p[0], p[1]]);
  for (const layer of edgeSurfacesOf(surface)) out = splitAtMeshEdges(layer, out);
  return out;
}

/** splitAtMeshEdges against one mesh grid; use splitAtAllMeshEdges for anything that may be a composite. */
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
 * liftM is one lift for every point, or one per input vertex (#64: the trail curtain top); an inserted point then takes
 * the lift interpolated linearly by plan distance between the two input vertices around it. The plan points are the
 * same either way.
 */
export function drapeLine(
  surface: MeshSurface,
  positions: ReadonlyArray<ReadonlyArray<number>>,
  maxStepM = MAX_STEP_M,
  liftM: number | readonly number[] = DRAPE_LIFT_M,
): Polyline3 {
  const flat = positions.map((p): Vec2 => [p[0] as number, p[1] as number]);
  let dense: Vec2[];
  let lifts: number[] | null = null;
  if (typeof liftM === 'number') {
    dense = densify(splitAtAllMeshEdges(surface, flat), maxStepM);
  } else {
    if (liftM.length !== flat.length) {
      throw new Error(`drapeLine: ${liftM.length} lift entries for ${flat.length} vertices`);
    }
    // Segment by segment gives the same points as the whole line: both splitting and densifying work per pair.
    const first = flat[0];
    dense = first === undefined ? [] : [[first[0], first[1]]];
    lifts = first === undefined ? [] : [liftM[0] as number];
    for (let k = 1; k < flat.length; k += 1) {
      const a = flat[k - 1] as Vec2;
      const b = flat[k] as Vec2;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const la = liftM[k - 1] as number;
      const lb = liftM[k] as number;
      const piece = densify(splitAtAllMeshEdges(surface, [a, b]), maxStepM);
      for (let p = 1; p < piece.length; p += 1) {
        const point = piece[p] as Vec2;
        const t = length === 0 ? 1 : Math.hypot(point[0] - a[0], point[1] - a[1]) / length;
        dense.push(point);
        lifts.push(la + t * (lb - la));
      }
    }
  }
  let clampedCount = 0;
  const points = dense.map(([east, north], i): Vec3 => {
    const s = surface.sample(east, north);
    if (s.clamped) clampedCount += 1;
    const lift = lifts === null ? (liftM as number) : (lifts[i] as number);
    return [east, north, finiteOrThrow(s.height, east, north) + lift];
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

/** Spacing of the points a smoothed trail is resampled to, in plan (#54). */
export const SMOOTH_STEP_M = 5;

/**
 * Resample a polyline through a centripetal Catmull-Rom spline (Barry-Goldman form) in plan. The curve passes through
 * every original vertex, so the endpoints are kept; each span gets ceil(length / stepM) pieces. Consecutive duplicate
 * points are dropped first, and a line of fewer than 3 distinct points stays straight. Elevation is carried by
 * interpolating linearly along the span; the caller drapes the result. Pure, so it tests in node.
 */
export function smoothPolyline(
  positions: ReadonlyArray<ReadonlyArray<number>>,
  stepM = SMOOTH_STEP_M,
): number[][] {
  const pts: number[][] = [];
  for (const p of positions) {
    const last = pts[pts.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    pts.push([p[0] as number, p[1] as number, p[2] ?? 0]);
  }
  if (pts.length < 3) return pts;
  const at = (i: number): number[] => {
    if (i < 0) {
      const a = pts[0] as number[];
      const b = pts[1] as number[];
      return [2 * a[0]! - b[0]!, 2 * a[1]! - b[1]!, a[2]!];
    }
    if (i >= pts.length) {
      const a = pts[pts.length - 1] as number[];
      const b = pts[pts.length - 2] as number[];
      return [2 * a[0]! - b[0]!, 2 * a[1]! - b[1]!, a[2]!];
    }
    return pts[i] as number[];
  };
  const mix = (a: number[], b: number[], wa: number, wb: number): number[] => [
    a[0]! * wa + b[0]! * wb,
    a[1]! * wa + b[1]! * wb,
  ];
  const out: number[][] = [[...(pts[0] as number[])]];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const knot = (a: number[], b: number[]): number =>
      Math.sqrt(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const length = Math.hypot(p2[0]! - p1[0]!, p2[1]! - p1[1]!);
    const pieces = Math.max(1, Math.ceil(length / stepM - 1e-9));
    for (let k = 1; k <= pieces; k += 1) {
      const f = k / pieces;
      if (k === pieces) {
        out.push([p2[0]!, p2[1]!, p2[2]!]);
        break;
      }
      const t = t1 + f * (t2 - t1);
      const a1 = mix(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
      const a2 = mix(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      const a3 = mix(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
      const b1 = mix(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
      const b2 = mix(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
      const c = mix(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
      out.push([c[0]!, c[1]!, p1[2]! + f * (p2[2]! - p1[2]!)]);
    }
  }
  return out;
}

/** Default distance between parallel sport strands of one trail, in plan (#54). */
export const LINE_SPACING_M = 2.5;

/**
 * Offset a polyline sideways in plan by offsetM (positive is to the left of travel, east/north axes). Each vertex moves
 * along the normalised average of its adjacent segment normals; an end vertex uses its one segment. Zero-length
 * segments are ignored, and a vertex with no usable segment stays put. Elevation is carried through unchanged: the
 * caller drapes the result. Pure, so it tests in node.
 */
export function offsetPolyline(
  positions: ReadonlyArray<ReadonlyArray<number>>,
  offsetM: number,
): number[][] {
  const normalOf = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): Vec2 | null => {
    const dx = (b[0] as number) - (a[0] as number);
    const dy = (b[1] as number) - (a[1] as number);
    const length = Math.hypot(dx, dy);
    return length === 0 ? null : [-dy / length, dx / length];
  };
  return positions.map((p, i) => {
    const before = i > 0 ? normalOf(positions[i - 1] as ReadonlyArray<number>, p) : null;
    const next = positions[i + 1];
    const after = next === undefined ? null : normalOf(p, next);
    let nx = (before?.[0] ?? 0) + (after?.[0] ?? 0);
    let ny = (before?.[1] ?? 0) + (after?.[1] ?? 0);
    const length = Math.hypot(nx, ny);
    if (length < 1e-9) {
      const fallback = before ?? after;
      nx = fallback?.[0] ?? 0;
      ny = fallback?.[1] ?? 0;
    } else {
      nx /= length;
      ny /= length;
    }
    return [(p[0] as number) + nx * offsetM, (p[1] as number) + ny * offsetM, p[2] ?? 0];
  });
}

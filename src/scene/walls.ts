/**
 * Trail walls (#64, #67, #73): every non-lift trail is one solid box extruded along the trail, from just below bare
 * earth up to the adjacent tree cover, k sport lanes wide, so a trail reads through the forest from any angle as a solid
 * object. The lanes are painted by the shader (applyWallLanes) from a per-vertex lane coordinate, never built as
 * separate boxes: k offset boxes folded into each other on tight bends (#73). The coloured line bands run along the top
 * edge (areas.ts drapes them there through drapeLine's per-vertex lift), and trees.ts removes every tree whose crown
 * would reach into a wall.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { SurfaceLoad } from '../data/load-surface';
import { ActivitySchema } from '../schema/annotation';
import type { SceneMapper } from './areas';
import { DRAPE_LIFT_M, type Vec3 } from './drape';
import { sampleHeight } from './heightfield';
import { SPORT_COLOR } from './palette';
import type { Activity } from './sport-routing';

/** Lowest wall, in metres: a trail in the open still gets a low lip. */
export const WALL_MIN_M = 2;
/** Highest wall, in metres: caps a spike in the canopy summary (a tower, a wire). */
export const WALL_MAX_M = 30;
/** Width of the moving maximum over the canopy samples along a line, in vertices (about 25 m at the 5 m resample). */
export const WALL_SMOOTH_VERTICES = 5;
/** Default thickness of one sport's wall, in metres; the DEBUG slider changes it (1 to 10). */
export const WALL_THICKNESS_M = 4;
/** The wall bottom sits this far below bare earth, so no gap opens on a cross slope. */
export const WALL_BURY_M = 0.5;
/** Longest mitre at a joint, as a multiple of the offset: a hairpin would otherwise throw a spike. */
export const WALL_MITRE_LIMIT = 2;
/** Most lanes one wall carries: the shader selects among four lane colours (applyWallLanes). */
export const WALL_MAX_LANES = 4;

/** Canopy height above bare earth at a plan point, in metres; NaN where the canopy summary (load-canopy.ts, #65) does not cover it. */
export type CanopyAt = (east: number, north: number) => number;

const clampCanopy = (h: number): number =>
  Math.min(Math.max(Number.isFinite(h) ? h : 0, WALL_MIN_M), WALL_MAX_M);

/**
 * Wall height per vertex of a line: the canopy sampled at each vertex, a WALL_SMOOTH_VERTICES moving maximum,
 * clamped to [WALL_MIN_M, WALL_MAX_M], times `scale` (the DEBUG factor). No canopy source gives WALL_MIN_M.
 */
export function canopyProfile(
  points: ReadonlyArray<ReadonlyArray<number>>,
  canopyAt: CanopyAt | null,
  scale = 1,
): number[] {
  const raw = points.map((p) => {
    if (canopyAt === null) return 0;
    const h = canopyAt(p[0] as number, p[1] as number);
    return Number.isFinite(h) ? Math.max(h, 0) : 0;
  });
  const half = Math.floor(WALL_SMOOTH_VERTICES / 2);
  return raw.map((_, i) => {
    let max = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j += 1) {
      max = Math.max(max, raw[j] as number);
    }
    return clampCanopy(max) * scale;
  });
}

/**
 * Not used by the app since #65 (walls read the canopy summary); kept for tooling. Canopy height from the first-return
 * surface: the core layer where it covers the point, else the square, minus the bare earth the wall stands on. Null when
 * neither layer loaded. Reads the full-resolution heightfields, so the surface meshes need not be built.
 */
export function canopyFromSurface(
  load: SurfaceLoad,
  bare: (east: number, north: number) => number,
): CanopyAt | null {
  const layers = [load.core, load.square].flatMap((layer) =>
    'error' in layer ? [] : [layer.heightfield],
  );
  if (layers.length === 0) return null;
  return (east, north) => {
    for (const field of layers) {
      const s = sampleHeight(field, east, north);
      if (!s.clamped) return s.height - bare(east, north);
    }
    return Number.NaN;
  };
}

/**
 * The walls of one trail, left to right looking along the line, in ActivitySchema order. A trail with fewer than two
 * annotated activities is one wall in its routed sport. With an Activity selection, walls of unselected sports drop
 * out (the rest re-centre); if none is left, the routed sport stands alone.
 */
export function wallSports(
  activities: readonly Activity[],
  selected: ReadonlySet<Activity>,
  routed: Activity,
): Activity[] {
  const unique = [...new Set(activities)];
  if (unique.length < 2) return [routed];
  const order = ActivitySchema.options;
  const sorted = unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const shown = selected.size > 0 ? sorted.filter((a) => selected.has(a)) : sorted;
  return shown.length > 0 ? shown : [routed];
}

/**
 * Centre offset of each of k lanes along the right-hand plan normal, in metres: (i - (k-1)/2) * thickness. Lane 0 is
 * the leftmost looking along the line, and the set is centred on the centreline.
 */
export function wallOffsets(k: number, thicknessM: number): number[] {
  return Array.from({ length: k }, (_, i) => (i - (k - 1) / 2) * thicknessM);
}

/** Plan right-hand unit normal per vertex, averaged at joints, with the mitre scale 1/cos(half-angle) (capped). */
export function mitredNormals(
  points: ReadonlyArray<ReadonlyArray<number>>,
): (readonly [number, number, number])[] {
  const normalOf = (
    a: ReadonlyArray<number>,
    b: ReadonlyArray<number>,
  ): readonly [number, number] | null => {
    const dx = (b[0] as number) - (a[0] as number);
    const dy = (b[1] as number) - (a[1] as number);
    const length = Math.hypot(dx, dy);
    return length === 0 ? null : [dy / length, -dx / length];
  };
  return points.map((p, i) => {
    const before = i > 0 ? normalOf(points[i - 1] as ReadonlyArray<number>, p) : null;
    const next = points[i + 1];
    const after = next === undefined ? null : normalOf(p, next);
    const sx = (before?.[0] ?? 0) + (after?.[0] ?? 0);
    const sy = (before?.[1] ?? 0) + (after?.[1] ?? 0);
    const length = Math.hypot(sx, sy);
    if (length < 1e-9) {
      const fallback = before ?? after ?? [0, 0];
      return [fallback[0], fallback[1], 1] as const;
    }
    const nx = sx / length;
    const ny = sy / length;
    const ref = before ?? after ?? [nx, ny];
    const cos = nx * ref[0] + ny * ref[1];
    const scale = Math.min(1 / Math.max(cos, 1e-9), WALL_MITRE_LIMIT);
    return [nx, ny, scale] as const;
  });
}

/**
 * The one wall material: lit (so the sides shade against the top), white times the lane colour (applyWallLanes), opaque
 * (opacity 1), front faces only, depth-tested and depth-written, no polygonOffset. One material and one merged mesh
 * keep every wall in a single draw call: a mesh per area cost 2.2 ms a frame at Overview in the browser (#64).
 */
export function createWallMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: FrontSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
  });
}

/**
 * The lane a fragment shows: floor(lane * k) clamped to [0, k - 1], with lane 0 at the left face and 1 at the right.
 * The CPU mirror of the GLSL in applyWallLanes, for tests and tooling.
 */
export function laneIndex(lane: number, k: number): number {
  return Math.min(Math.max(Math.floor(lane * k), 0), k - 1);
}

const LANES_MARKER = 'wallLanes';

/** Vertex declarations and the pass-through of the lane attributes (buildTrailWalls writes them). */
const LANE_VERTEX_DECLARATIONS = [
  'attribute float lane;',
  'attribute float laneCount;',
  'attribute vec3 laneColor1;',
  'attribute vec3 laneColor2;',
  'attribute vec3 laneColor3;',
  'varying float vWallLane;',
  'varying float vWallLaneCount;',
  'varying vec3 vWallLaneColor1;',
  'varying vec3 vWallLaneColor2;',
  'varying vec3 vWallLaneColor3;',
].join('\n');
const LANE_VERTEX_ASSIGN = [
  'vWallLane = lane;',
  'vWallLaneCount = laneCount;',
  'vWallLaneColor1 = laneColor1;',
  'vWallLaneColor2 = laneColor2;',
  'vWallLaneColor3 = laneColor3;',
].join('\n');
const LANE_FRAGMENT_DECLARATIONS = [
  'varying float vWallLane;',
  'varying float vWallLaneCount;',
  'varying vec3 vWallLaneColor1;',
  'varying vec3 vWallLaneColor2;',
  'varying vec3 vWallLaneColor3;',
].join('\n');
/**
 * Replaces three's color_fragment: the vertex colour (lane 0) or lane 1..3 by a step on floor(lane * k), so the left
 * face is lane 0, the right face lane k-1, and the top and end caps show k stripes. Every lane colour is constant over
 * a trail, so interpolation never mixes two of them.
 */
const LANE_SELECT = `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
{
  float wallLaneIndex = clamp(floor(vWallLane * vWallLaneCount), 0.0, max(vWallLaneCount - 1.0, 0.0));
  vec3 wallLaneColor = vColor.rgb;
  wallLaneColor = mix(wallLaneColor, vWallLaneColor1, step(0.5, wallLaneIndex));
  wallLaneColor = mix(wallLaneColor, vWallLaneColor2, step(1.5, wallLaneIndex));
  wallLaneColor = mix(wallLaneColor, vWallLaneColor3, step(2.5, wallLaneIndex));
  diffuseColor.rgb *= wallLaneColor;
}
#endif`;

/**
 * Patches the wall material so each fragment takes its lane's colour (#73). Call it AFTER applyRadialFade, which
 * replaces onBeforeCompile outright, and before applyHorizonBlend: it wraps whatever onBeforeCompile and
 * customProgramCacheKey the material already has, the way horizon.ts does. Idempotent per material.
 */
export function applyWallLanes(material: Material): void {
  if (material.userData[LANES_MARKER]) return;
  material.userData[LANES_MARKER] = true;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LANE_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LANE_VERTEX_ASSIGN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LANE_FRAGMENT_DECLARATIONS}`)
      .replace('#include <color_fragment>', LANE_SELECT);
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}+wall-lanes`;
  material.needsUpdate = true;
}

/**
 * One side of the wall with every fold removed: where the offset edge into vertex i runs against the centreline
 * segment into i (the inner side of a bend tighter than the offset, the classic offset-curve fold), vertex i clamps to
 * the previous kept point, so the side never reverses; cutLoops then removes any loop the side still ties within
 * maxLoopM of centreline. The vertex count is kept, so the top and side faces still pair vertex i with vertex i.
 */
export function foldFreeSide(
  side: readonly (readonly [number, number])[],
  centre: readonly (readonly [number, number])[],
  maxLoopM = Number.POSITIVE_INFINITY,
): [number, number][] {
  const out: [number, number][] = [];
  side.forEach((q, i) => {
    const last = out[i - 1];
    const a = centre[i - 1];
    const b = centre[i];
    if (last === undefined || a === undefined || b === undefined) {
      out.push([q[0], q[1]]);
      return;
    }
    const along = (q[0] - last[0]) * (b[0] - a[0]) + (q[1] - last[1]) * (b[1] - a[1]);
    out.push(along > 0 ? [q[0], q[1]] : [last[0], last[1]]);
  });
  return cutLoops(out, centre, maxLoopM);
}

/** Where segments p0-p1 and q0-q1 cross properly (not at a shared end), or null. */
function crossing(
  p0: readonly [number, number],
  p1: readonly [number, number],
  q0: readonly [number, number],
  q1: readonly [number, number],
): [number, number] | null {
  const rx = p1[0] - p0[0];
  const ry = p1[1] - p0[1];
  const sx = q1[0] - q0[0];
  const sy = q1[1] - q0[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = q0[0] - p0[0];
  const qy = q0[1] - p0[1];
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const eps = 1e-9;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return [p0[0] + t * rx, p0[1] + t * ry];
}

/**
 * Removes the small loops a side can still tie where it steps forward vertex by vertex yet comes back across itself
 * (the inner side of a switchback tighter than the wall is wide): when segment i crosses an earlier segment j whose
 * centreline lies within maxLoopM of it, every vertex between them moves to the crossing point. The side then follows
 * the outline of the wall's union, as an offset curve should. A trail that really crosses itself is further apart along
 * the centreline than maxLoopM and keeps its crossing. Deterministic, keeps the vertex count.
 */
function cutLoops(
  side: [number, number][],
  centre: readonly (readonly [number, number])[],
  maxLoopM: number,
): [number, number][] {
  const n = side.length;
  const distance: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    const a = centre[i - 1] as readonly [number, number];
    const b = centre[i] as readonly [number, number];
    distance.push((distance[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  for (let i = 2; i + 1 < n; i += 1) {
    const p0 = side[i] as [number, number];
    const p1 = side[i + 1] as [number, number];
    for (let j = i - 2; j >= 0; j -= 1) {
      if ((distance[i] as number) - (distance[j + 1] as number) > maxLoopM) break;
      const x = crossing(side[j] as [number, number], side[j + 1] as [number, number], p0, p1);
      if (x === null) continue;
      for (let t = j + 1; t <= i; t += 1) side[t] = [x[0], x[1]];
      break;
    }
  }
  return side;
}

/** Linear working-space colour of a sport, as a vertex colour (the material multiplies it by white). */
const SPORT_LINEAR = new Map(
  (Object.keys(SPORT_COLOR) as Activity[]).map((sport) => {
    const c = new Color(SPORT_COLOR[sport]);
    return [sport, [c.r, c.g, c.b] as const];
  }),
);

/** The linear vertex colour a wall of this sport carries. */
export function sportVertexColor(sport: Activity): readonly [number, number, number] {
  return SPORT_LINEAR.get(sport) ?? [1, 1, 1];
}

/** Vertices in one closed wall box over n line vertices: two sides (2n each), the top (2n), two end caps (4 each). */
export const wallVertexCount = (n: number): number => 6 * n + 8;
/** Index count of one wall box over n line vertices: sides and top 18 per segment, 12 for the two caps. */
export const wallIndexCount = (n: number): number => 18 * (n - 1) + 12;

/** Every per-vertex attribute of a wall geometry, with its item size; mergeWalls carries each one. */
export const WALL_ATTRIBUTES = [
  ['position', 3],
  ['normal', 3],
  /** Lane 0's colour: three's vertex-colour path, which the radial fade and the horizon blend already work with. */
  ['color', 3],
  ['laneColor1', 3],
  ['laneColor2', 3],
  ['laneColor3', 3],
  /** 0 at the left face, 1 at the right face; the top and caps interpolate across. */
  ['lane', 1],
  /** k, the number of lanes this trail shows. */
  ['laneCount', 1],
] as const;

export interface TrailWalls {
  readonly areaId: string;
  /** This trail's wall: the WALL_ATTRIBUTES, indexed; replaced (not mutated) on every change. */
  readonly geometry: BufferGeometry;
  /** The visible lanes, left to right. */
  readonly sports: readonly Activity[];
  /** Plan centreline of the trail, east and north in local metres. */
  readonly centreline: readonly (readonly [number, number])[];
  /** Half the width of the full set (every annotated sport, filtered or not): the tree cull distance before the crown. */
  readonly setHalfWidthM: number;
  /** Whether the wall goes into the merged mesh: the area's filter visibility. */
  visible: boolean;
  /** Re-shapes the wall under a re-draped line (world points of the line, DRAPE_LIFT_M above the wall top). */
  setLine(world: readonly Vec3[], bare: (east: number, north: number) => number): void;
  /** Sets the visible lanes, left to right (at most WALL_MAX_LANES), and the size of the full set (default: as many as visible). */
  setSports(sports: readonly Activity[], fullSetSize?: number): void;
  /** Sets the thickness of one lane in metres and rebuilds. */
  setThickness(metres: number): void;
}

interface FacePoint {
  readonly e: number;
  readonly n: number;
  readonly lo: number;
  readonly hi: number;
}

/**
 * @displayName Trail walls
 * @strategicPurpose Gives a trail solid 3D thickness up to the adjacent tree cover, so it reads through the forest as a
 *   block and never shows its far side through its near side, with one lane per sport that can never fold into another.
 * @tacticalObjective One BufferGeometry per trail: one closed box (left and right sides, top, two end caps, flat
 *   normals, outward winding) k lanes wide, extruded along the draped line from bare earth minus WALL_BURY_M to the line
 *   height minus DRAPE_LIFT_M, each side fold-free (foldFreeSide). Every vertex carries the k lane colours and its lane
 *   coordinate; applyWallLanes paints the lanes. mergeWalls draws every trail in one call.
 */
export function buildTrailWalls(
  areaId: string,
  world: readonly Vec3[],
  bare: (east: number, north: number) => number,
  toScene: SceneMapper,
  thicknessM = WALL_THICKNESS_M,
): TrailWalls {
  let plan: (readonly [number, number])[] = [];
  let tops: number[] = [];
  let bareAt = bare;
  let sports: Activity[] = [];
  let fullSet = 1;
  let thickness = thicknessM;
  let geometry = new BufferGeometry();

  const write = (): void => {
    const n = plan.length;
    const k = sports.length;
    const normals = mitredNormals(plan);
    const tangents = [0, n - 1].map((i) => {
      const a = plan[Math.max(0, i - 1)] as readonly [number, number];
      const b = plan[Math.min(n - 1, i + 1)] as readonly [number, number];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as const;
    });
    const half = (k * thickness) / 2;
    // Lane colours, padded with the last lane (never selected past k - 1).
    const laneRgb = Array.from({ length: WALL_MAX_LANES }, (_, i) =>
      sportVertexColor(sports[Math.min(i, k - 1)] as Activity),
    );
    const total = wallVertexCount(n);
    const arrays = new Map(
      WALL_ATTRIBUTES.map(([name, size]) => [name, new Float32Array(total * size)] as const),
    );
    const array = (name: (typeof WALL_ATTRIBUTES)[number][0]): Float32Array =>
      arrays.get(name) as Float32Array;
    const index: number[] = [];
    let v = 0;
    const put = (
      east: number,
      north: number,
      z: number,
      nrm: readonly number[],
      lane: 0 | 1,
    ): number => {
      array('position').set(toScene(east, north, z), v * 3);
      array('normal').set(nrm, v * 3);
      array('color').set(laneRgb[0] as readonly number[], v * 3);
      array('laneColor1').set(laneRgb[1] as readonly number[], v * 3);
      array('laneColor2').set(laneRgb[2] as readonly number[], v * 3);
      array('laneColor3').set(laneRgb[3] as readonly number[], v * 3);
      array('lane')[v] = lane;
      array('laneCount')[v] = k;
      v += 1;
      return v - 1;
    };
    // Side 0 is the left face (offset -half), side 1 the right face (+half); each mitred, then cleared of folds.
    const [left, right] = [-half, half].map((offset) =>
      foldFreeSide(
        plan.map((p, i) => {
          const [nx, ny, scale] = normals[i] as readonly [number, number, number];
          return [p[0] + nx * scale * offset, p[1] + ny * scale * offset] as const;
        }),
        plan,
        // A loop the offset ties runs at most one full turn of the wall's width along the centreline.
        2 * Math.PI * 2 * half,
      ).map(([e, nn], i): FacePoint => {
        const top = tops[i] as number;
        return { e, n: nn, lo: Math.min(bareAt(e, nn) - WALL_BURY_M, top), hi: top };
      }),
    ) as [FacePoint[], FacePoint[]];
    // Left and right faces: a lo row then a hi row each.
    for (const [face, sign, lane] of [
      [left, -1, 0],
      [right, 1, 1],
    ] as const) {
      const base = v;
      for (const row of ['lo', 'hi'] as const) {
        for (let i = 0; i < n; i += 1) {
          const [nx, ny] = normals[i] as readonly [number, number, number];
          const q = face[i] as FacePoint;
          put(q.e, q.n, q[row], [sign * nx, 0, -sign * ny], lane);
        }
      }
      for (let i = 0; i + 1 < n; i += 1) {
        const a = base + i;
        const b = base + i + 1;
        const c = base + n + i;
        const d = base + n + i + 1;
        if (sign > 0) index.push(a, b, c, b, d, c);
        else index.push(a, c, b, b, c, d);
      }
    }
    // Top face: the left top row (lane 0) then the right top row (lane 1); the shader stripes it k ways.
    const topBase = v;
    for (const [face, lane] of [
      [left, 0],
      [right, 1],
    ] as const) {
      for (const q of face) put(q.e, q.n, q.hi, [0, 1, 0], lane);
    }
    for (let i = 0; i + 1 < n; i += 1) {
      const l0 = topBase + i;
      const l1 = topBase + i + 1;
      const r0 = topBase + n + i;
      const r1 = topBase + n + i + 1;
      index.push(l0, r0, l1, l1, r0, r1);
    }
    // End caps: start faces back along the line, end faces forward; both show all k lanes.
    for (const [i, forward] of [
      [0, false],
      [n - 1, true],
    ] as const) {
      const t = tangents[forward ? 1 : 0] as readonly [number, number];
      const sign = forward ? 1 : -1;
      const nrm = [sign * t[0], 0, -sign * t[1]];
      const l = left[i] as FacePoint;
      const r = right[i] as FacePoint;
      const llo = put(l.e, l.n, l.lo, nrm, 0);
      const rlo = put(r.e, r.n, r.lo, nrm, 1);
      const lhi = put(l.e, l.n, l.hi, nrm, 0);
      const rhi = put(r.e, r.n, r.hi, nrm, 1);
      if (forward) index.push(llo, lhi, rlo, rlo, lhi, rhi);
      else index.push(llo, rlo, lhi, rlo, rhi, lhi);
    }
    const next = new BufferGeometry();
    for (const [name, size] of WALL_ATTRIBUTES) {
      next.setAttribute(name, new BufferAttribute(array(name), size));
    }
    next.setIndex(index);
    geometry.dispose();
    geometry = next;
  };

  const walls: TrailWalls = {
    areaId,
    get geometry() {
      return geometry;
    },
    get sports() {
      return sports;
    },
    get centreline() {
      return plan;
    },
    get setHalfWidthM() {
      return (fullSet * thickness) / 2;
    },
    visible: true,
    setLine(points, nextBare) {
      bareAt = nextBare;
      plan = points.map(([e, n]) => [e, n] as const);
      tops = points.map(([, , z]) => z - DRAPE_LIFT_M);
      if (sports.length > 0) write();
    },
    setSports(next, fullSetSize = next.length) {
      if (next.length > WALL_MAX_LANES) {
        throw new Error(
          `${areaId}: ${next.length} wall lanes (${next.join(', ')}); the lane shader carries at most ${WALL_MAX_LANES}`,
        );
      }
      sports = [...next];
      fullSet = Math.max(1, fullSetSize, next.length);
      write();
    },
    setThickness(metres) {
      thickness = metres;
      if (sports.length > 0) write();
    },
  };
  walls.setLine(world, bare);
  return walls;
}

/**
 * Concatenates the visible trails' walls into one indexed geometry (every WALL_ATTRIBUTES entry), so every wall draws in
 * one call. Glue only: three's mergeGeometries would also do it, but adds groups this mesh does not want.
 */
export function mergeWalls(walls: Iterable<TrailWalls>): BufferGeometry {
  const shown = [...walls].filter((w) => w.visible && w.geometry.index !== null);
  const vertexCount = shown.reduce((sum, w) => sum + w.geometry.getAttribute('position').count, 0);
  const merged = new BufferGeometry();
  for (const [name, size] of WALL_ATTRIBUTES) {
    const out = new Float32Array(vertexCount * size);
    let offset = 0;
    for (const w of shown) {
      const attribute = w.geometry.getAttribute(name);
      out.set(attribute.array as Float32Array, offset * size);
      offset += attribute.count;
    }
    merged.setAttribute(name, new BufferAttribute(out, size));
  }
  const index: number[] = [];
  let offset = 0;
  for (const w of shown) {
    for (const i of (w.geometry.index as BufferAttribute).array) index.push(i + offset);
    offset += w.geometry.getAttribute('position').count;
  }
  merged.setIndex(index);
  merged.computeBoundingSphere();
  return merged;
}

/** The merged wall mesh: never picked (#13 picks Line2 objects only). */
export function createWallMesh(material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = 'walls';
  mesh.raycast = () => {};
  return mesh;
}

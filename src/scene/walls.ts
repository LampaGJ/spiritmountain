/**
 * Trail walls (#64, #67): every non-lift trail is a set of solid boxes extruded along the trail, from just below bare
 * earth up to the adjacent tree cover, one box per sport side by side in plan, so a trail reads through the forest from
 * any angle as a solid object. The coloured line bands run along the top edge (areas.ts drapes them there through
 * drapeLine's per-vertex lift), and trees.ts removes every tree whose crown would reach into a wall.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
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
 * Centre offset of each of k walls along the right-hand plan normal, in metres: (i - (k-1)/2) * thickness. Wall 0 is
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
 * The one wall material: lit (so the sides shade against the top), white times the per-vertex sport colour, opaque
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

export interface TrailWalls {
  readonly areaId: string;
  /** This trail's walls: position, normal and color attributes, indexed; replaced (not mutated) on every change. */
  readonly geometry: BufferGeometry;
  /** The visible walls, left to right. */
  readonly sports: readonly Activity[];
  /** Plan centreline of the trail, east and north in local metres. */
  readonly centreline: readonly (readonly [number, number])[];
  /** Half the width of the full set (every annotated sport, filtered or not): the tree cull distance before the crown. */
  readonly setHalfWidthM: number;
  /** Whether the walls go into the merged mesh: the area's filter visibility. */
  visible: boolean;
  /** Re-shapes the walls under a re-draped line (world points of the line, DRAPE_LIFT_M above the wall top). */
  setLine(world: readonly Vec3[], bare: (east: number, north: number) => number): void;
  /** Sets the visible walls, left to right, and the size of the full set (default: as many as visible). */
  setSports(sports: readonly Activity[], fullSetSize?: number): void;
  /** Sets the thickness of one wall in metres and rebuilds. */
  setThickness(metres: number): void;
}

/**
 * @displayName Trail walls
 * @strategicPurpose Gives a trail solid 3D thickness up to the adjacent tree cover, so it reads through the forest as a
 *   block and never shows its far side through its near side.
 * @tacticalObjective One BufferGeometry per trail: per sport a closed box (left and right sides, top, two end caps,
 *   flat normals, outward winding) extruded along the draped line, offset side by side in plan, from bare earth minus
 *   WALL_BURY_M to the line height minus DRAPE_LIFT_M, every vertex coloured with its sport. mergeWalls draws them.
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
    const normals = mitredNormals(plan);
    const tangents = [0, n - 1].map((i) => {
      const a = plan[Math.max(0, i - 1)] as readonly [number, number];
      const b = plan[Math.min(n - 1, i + 1)] as readonly [number, number];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as const;
    });
    const offsets = wallOffsets(sports.length, thickness);
    const half = thickness / 2;
    const total = sports.length * wallVertexCount(n);
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const color = new Float32Array(total * 3);
    const index: number[] = [];
    let v = 0;
    const put = (
      east: number,
      north: number,
      z: number,
      nrm: readonly number[],
      rgb: readonly number[],
    ): number => {
      position.set(toScene(east, north, z), v * 3);
      normal.set(nrm, v * 3);
      color.set(rgb, v * 3);
      v += 1;
      return v - 1;
    };
    /** Plan point at a signed right-hand offset from centreline vertex i, mitred. */
    const at = (i: number, offset: number): readonly [number, number] => {
      const p = plan[i] as readonly [number, number];
      const [nx, ny, scale] = normals[i] as readonly [number, number, number];
      return [p[0] + nx * scale * offset, p[1] + ny * scale * offset];
    };
    sports.forEach((sport, s) => {
      const rgb = sportVertexColor(sport);
      const centre = offsets[s] as number;
      // Side 0 is the left face (offset centre - half), side 1 the right face (centre + half).
      const sides = [centre - half, centre + half].map((offset) =>
        plan.map((_, i) => {
          const [e, nn] = at(i, offset);
          const top = tops[i] as number;
          return { e, n: nn, lo: Math.min(bareAt(e, nn) - WALL_BURY_M, top), hi: top };
        }),
      );
      const left = sides[0] as { e: number; n: number; lo: number; hi: number }[];
      const right = sides[1] as { e: number; n: number; lo: number; hi: number }[];
      // Left and right faces: a lo row then a hi row each.
      for (const [face, sign] of [
        [left, -1],
        [right, 1],
      ] as const) {
        const base = v;
        for (let i = 0; i < n; i += 1) {
          const [nx, ny] = normals[i] as readonly [number, number, number];
          const q = face[i] as { e: number; n: number; lo: number };
          put(q.e, q.n, q.lo, [sign * nx, 0, -sign * ny], rgb);
        }
        for (let i = 0; i < n; i += 1) {
          const [nx, ny] = normals[i] as readonly [number, number, number];
          const q = face[i] as { e: number; n: number; hi: number };
          put(q.e, q.n, q.hi, [sign * nx, 0, -sign * ny], rgb);
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
      // Top face: the left top row then the right top row.
      const topBase = v;
      for (const face of [left, right]) {
        for (const q of face) put(q.e, q.n, q.hi, [0, 1, 0], rgb);
      }
      for (let i = 0; i + 1 < n; i += 1) {
        const l0 = topBase + i;
        const l1 = topBase + i + 1;
        const r0 = topBase + n + i;
        const r1 = topBase + n + i + 1;
        index.push(l0, r0, l1, l1, r0, r1);
      }
      // End caps: start faces back along the line, end faces forward.
      for (const [i, forward] of [
        [0, false],
        [n - 1, true],
      ] as const) {
        const t = tangents[forward ? 1 : 0] as readonly [number, number];
        const sign = forward ? 1 : -1;
        const nrm = [sign * t[0], 0, -sign * t[1]];
        const l = left[i] as { e: number; n: number; lo: number; hi: number };
        const r = right[i] as { e: number; n: number; lo: number; hi: number };
        const llo = put(l.e, l.n, l.lo, nrm, rgb);
        const rlo = put(r.e, r.n, r.lo, nrm, rgb);
        const lhi = put(l.e, l.n, l.hi, nrm, rgb);
        const rhi = put(r.e, r.n, r.hi, nrm, rgb);
        if (forward) index.push(llo, lhi, rlo, rlo, lhi, rhi);
        else index.push(llo, rlo, lhi, rlo, rhi, lhi);
      }
    });
    const next = new BufferGeometry();
    next.setAttribute('position', new BufferAttribute(position, 3));
    next.setAttribute('normal', new BufferAttribute(normal, 3));
    next.setAttribute('color', new BufferAttribute(color, 3));
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
 * Concatenates the visible trails' walls into one indexed geometry (position, normal, color), so every wall draws in
 * one call. Glue only: three's mergeGeometries would also do it, but adds groups this mesh does not want.
 */
export function mergeWalls(walls: Iterable<TrailWalls>): BufferGeometry {
  const shown = [...walls].filter((w) => w.visible && w.geometry.index !== null);
  const vertexCount = shown.reduce((sum, w) => sum + w.geometry.getAttribute('position').count, 0);
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index: number[] = [];
  let offset = 0;
  for (const w of shown) {
    const pos = w.geometry.getAttribute('position');
    position.set(pos.array as Float32Array, offset * 3);
    normal.set(w.geometry.getAttribute('normal').array as Float32Array, offset * 3);
    color.set(w.geometry.getAttribute('color').array as Float32Array, offset * 3);
    for (const i of (w.geometry.index as BufferAttribute).array) index.push(i + offset);
    offset += pos.count;
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(position, 3));
  merged.setAttribute('normal', new BufferAttribute(normal, 3));
  merged.setAttribute('color', new BufferAttribute(color, 3));
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

/**
 * Trail curtains (#64): a vertical wall under every non-lift trail, from bare earth up to the adjacent tree cover, so a
 * trail reads through the forest from any angle. The coloured line bands run along the top edge (areas.ts drapes them
 * there through drapeLine's per-vertex lift).
 */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial } from 'three';
import type { SurfaceLoad } from '../data/load-surface';
import { ActivitySchema } from '../schema/annotation';
import type { SceneMapper } from './areas';
import { DRAPE_LIFT_M, type Vec3 } from './drape';
import { sampleHeight } from './heightfield';
import { SPORT_COLOR } from './palette';
import type { Activity } from './sport-routing';

/** Lowest curtain, in metres: a trail in the open still gets a low lip. */
export const CURTAIN_MIN_M = 2;
/** Highest curtain, in metres: caps a spike in the first-return raster (a tower, a wire). */
export const CURTAIN_MAX_M = 30;
/** Curtain material opacity. */
export const CURTAIN_OPACITY = 0.85;
/** Width of the moving maximum over the canopy samples along a line, in vertices (about 25 m at the 5 m resample). */
export const CURTAIN_SMOOTH_VERTICES = 5;

/** Canopy height above bare earth at a plan point, in metres; NaN where the canopy summary (load-canopy.ts, #65) does not cover it. */
export type CanopyAt = (east: number, north: number) => number;

const clampCanopy = (h: number): number =>
  Math.min(Math.max(Number.isFinite(h) ? h : 0, CURTAIN_MIN_M), CURTAIN_MAX_M);

/**
 * Curtain height per vertex of a line: the canopy sampled at each vertex, a CURTAIN_SMOOTH_VERTICES moving maximum,
 * clamped to [CURTAIN_MIN_M, CURTAIN_MAX_M], times `scale` (the DEBUG factor). No canopy source gives CURTAIN_MIN_M.
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
  const half = Math.floor(CURTAIN_SMOOTH_VERTICES / 2);
  return raw.map((_, i) => {
    let max = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j += 1) {
      max = Math.max(max, raw[j] as number);
    }
    return clampCanopy(max) * scale;
  });
}

/**
 * Not used by the app since #65 (curtains read the canopy summary); kept for tooling. Canopy height from the first-return surface: the core layer where it covers the point, else the square, minus the
 * bare earth the curtain stands on. Null when neither layer loaded. Reads the full-resolution heightfields, so the
 * surface meshes need not be built.
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
 * The stripes of one curtain, bottom to top, in ActivitySchema order. A trail with fewer than two annotated
 * activities is one stripe in its routed sport. With an Activity selection, stripes of unselected sports drop out
 * (the rest share the height); if none is left, the routed sport stands alone.
 */
export function curtainStripes(
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
 * The one curtain material: white times the per-vertex sport colour, double-sided, CURTAIN_OPACITY, depth-tested and
 * depth-written, no polygonOffset. One material and one merged mesh keep every curtain in a single draw call: a mesh per
 * area cost 2.2 ms a frame at Overview in the browser, over the 2 ms budget.
 */
export function createCurtainMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: DoubleSide,
    transparent: true,
    opacity: CURTAIN_OPACITY,
    depthTest: true,
    depthWrite: true,
  });
}

/** Linear working-space colour of a sport, as a vertex colour (MeshBasicMaterial multiplies it by the white material). */
const SPORT_LINEAR = new Map(
  (Object.keys(SPORT_COLOR) as Activity[]).map((sport) => {
    const c = new Color(SPORT_COLOR[sport]);
    return [sport, [c.r, c.g, c.b] as const];
  }),
);

/** The linear vertex colour a curtain stripe of this sport carries. */
export function sportVertexColor(sport: Activity): readonly [number, number, number] {
  return SPORT_LINEAR.get(sport) ?? [1, 1, 1];
}

export interface Curtain {
  readonly areaId: string;
  /** This area's wall: position and color attributes, indexed; replaced (not mutated) on every change. */
  readonly geometry: BufferGeometry;
  /** The visible stripes, bottom to top. */
  readonly stripes: readonly Activity[];
  /** Whether the wall goes into the merged mesh: the area's filter visibility. */
  visible: boolean;
  /** Re-shapes the wall under a re-draped line (world points of the line, DRAPE_LIFT_M above the curtain top). */
  setLine(world: readonly Vec3[], bare: (east: number, north: number) => number): void;
  /** Sets the visible stripes, bottom to top. Heights redistribute evenly. */
  setStripes(sports: readonly Activity[]): void;
}

/**
 * @displayName Trail curtain
 * @strategicPurpose Gives a trail vertical thickness up to the adjacent tree cover, so it reads through the forest.
 * @tacticalObjective One BufferGeometry per area: one vertical quad strip per stripe along the draped line, from bare
 *   earth to the line height minus DRAPE_LIFT_M, each vertex coloured with its stripe's sport. mergeCurtains draws them.
 */
export function buildCurtain(
  areaId: string,
  world: readonly Vec3[],
  bare: (east: number, north: number) => number,
  toScene: SceneMapper,
): Curtain {
  let bottoms: Vec3[] = [];
  let tops: Vec3[] = [];
  let stripes: Activity[] = [];
  let geometry = new BufferGeometry();

  const write = (): void => {
    const n = bottoms.length;
    const m = stripes.length;
    const next = new BufferGeometry();
    const position = new Float32Array(m * 2 * n * 3);
    const color = new Float32Array(m * 2 * n * 3);
    const index: number[] = [];
    const lerp = (a: Vec3, b: Vec3, t: number): number => a[2] + t * (b[2] - a[2]);
    for (let s = 0; s < m; s += 1) {
      const base = s * 2 * n;
      const rgb = sportVertexColor(stripes[s] as Activity);
      for (let i = 0; i < n; i += 1) {
        const lo = bottoms[i] as Vec3;
        const hi = tops[i] as Vec3;
        const [x0, y0, z0] = toScene(lo[0], lo[1], lerp(lo, hi, s / m));
        const [x1, y1, z1] = toScene(lo[0], lo[1], lerp(lo, hi, (s + 1) / m));
        position.set([x0, y0, z0], (base + i) * 3);
        position.set([x1, y1, z1], (base + n + i) * 3);
        color.set(rgb, (base + i) * 3);
        color.set(rgb, (base + n + i) * 3);
      }
      for (let i = 0; i + 1 < n; i += 1) {
        const a = base + i;
        const b = base + i + 1;
        const c = base + n + i;
        const d = base + n + i + 1;
        index.push(a, b, c, b, d, c);
      }
    }
    next.setAttribute('position', new BufferAttribute(position, 3));
    next.setAttribute('color', new BufferAttribute(color, 3));
    next.setIndex(index);
    geometry.dispose();
    geometry = next;
  };

  const curtain: Curtain = {
    areaId,
    get geometry() {
      return geometry;
    },
    get stripes() {
      return stripes;
    },
    visible: true,
    setLine(points, bareAt) {
      bottoms = points.map(([e, n]): Vec3 => [e, n, bareAt(e, n)]);
      tops = points.map(([e, n, z]): Vec3 => [e, n, z - DRAPE_LIFT_M]);
      write();
    },
    setStripes(sports) {
      stripes = [...sports];
      write();
    },
  };
  curtain.setLine(world, bare);
  return curtain;
}

/**
 * Concatenates the visible curtains into one indexed geometry (position, color), so every wall draws in one call.
 * Glue only: three's mergeGeometries would also do it, but adds groups this mesh does not want.
 */
export function mergeCurtains(curtains: Iterable<Curtain>): BufferGeometry {
  const shown = [...curtains].filter((c) => c.visible && c.geometry.index !== null);
  const vertexCount = shown.reduce((sum, c) => sum + c.geometry.getAttribute('position').count, 0);
  const position = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index: number[] = [];
  let offset = 0;
  for (const c of shown) {
    const pos = c.geometry.getAttribute('position');
    position.set(pos.array as Float32Array, offset * 3);
    color.set(c.geometry.getAttribute('color').array as Float32Array, offset * 3);
    for (const i of (c.geometry.index as BufferAttribute).array) index.push(i + offset);
    offset += pos.count;
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(position, 3));
  merged.setAttribute('color', new BufferAttribute(color, 3));
  merged.setIndex(index);
  merged.computeBoundingSphere();
  return merged;
}

/** The merged curtain mesh: never picked (#13 picks Line2 objects only). */
export function createCurtainMesh(material: MeshBasicMaterial): Mesh {
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = 'curtains';
  mesh.raycast = () => {};
  return mesh;
}

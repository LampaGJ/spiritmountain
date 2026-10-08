import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Material } from 'three';
import type { AreaEntry, SceneMapper } from './areas';
import type { Vec3 } from './drape';
import { applyRadialFade, type RadialFadeOptions } from './fade';

/** Sideways offset of each haul rope from the lift line, and the radius of the bullwheel semicircle at each terminal. */
export const ROPE_OFFSET_M = 1.5;
/** Target gap between chairs along the rope loop. */
export const CHAIR_SPACING_M = 18;
/** Default chair speed along the rope. */
export const CHAIR_SPEED_MPS = 2.5;
/** Hanger length: chairs hang this far below the rope. */
export const HANGER_M = 2.5;
/** A frame longer than this advances the phase by this much only, so a resumed tab does not jump. */
export const MAX_FRAME_DELTA_MS = 100;
/** Segments in each bullwheel semicircle. */
export const BULLWHEEL_SEGMENTS = 16;
/** Longest miter, as a multiple of the rope offset, at a bend in the lift line. */
const MAX_MITER = 2;

export interface LoopPoint {
  readonly east: number;
  readonly north: number;
  readonly elevation: number;
  /** Unit direction of travel in the plan (east, north); (1, 0) for a loop with no horizontal travel. */
  readonly tangentEast: number;
  readonly tangentNorth: number;
}

/**
 * @displayName Lift haul-rope loop
 * @strategicPurpose Gives the chair animation one closed path per lift, so chairs climb one rope, round the top
 *   bullwheel, descend the other and round the bottom bullwheel (#68).
 * @tacticalObjective Holds the up-line and down-line vertex lists (bottom to top, world metres) and the closed loop
 *   polyline through both bullwheels; loopPoint(s) returns the position and plan tangent at distance s along it.
 */
export interface LiftLoop {
  /** Left-hand rope looking uphill from the bottom terminal, bottom to top, one vertex per cable vertex. */
  readonly up: readonly Vec3[];
  /** Right-hand rope, bottom to top. */
  readonly down: readonly Vec3[];
  /** Closed loop length in metres (3D). */
  readonly length: number;
  /** True when the cable's own vertex order runs top to bottom. */
  readonly reversed: boolean;
  loopPoint(s: number): LoopPoint;
}

type Vec2 = readonly [number, number];

function unit(x: number, y: number): Vec2 {
  const l = Math.hypot(x, y);
  return l === 0 ? [1, 0] : [x / l, y / l];
}

/**
 * Builds the rope loop for a lift cable (vertices at ground plus the cable height, world metres). The lower end is the
 * bottom terminal. The ropes keep the cable's own heights and bends: each is the cable polyline offset sideways by
 * radiusM (mitred at bends), so a lift whose line curves still has its ropes on the line. Throws for fewer than two
 * distinct plan points.
 */
export function buildLiftLoop(cable: readonly Vec3[], radiusM = ROPE_OFFSET_M): LiftLoop {
  const distinct = cable.filter(
    (p, i) => i === 0 || p[0] !== (cable[i - 1] as Vec3)[0] || p[1] !== (cable[i - 1] as Vec3)[1],
  );
  if (distinct.length < 2) throw new Error('lift loop: a lift needs at least 2 distinct points');
  const reversed = (distinct[0] as Vec3)[2] > (distinct[distinct.length - 1] as Vec3)[2];
  const oriented: Vec3[] = reversed ? [...distinct].reverse() : distinct;
  const n = oriented.length;
  const dirs: Vec2[] = [];
  for (let k = 1; k < n; k += 1) {
    const a = oriented[k - 1] as Vec3;
    const b = oriented[k] as Vec3;
    dirs.push(unit(b[0] - a[0], b[1] - a[1]));
  }
  /** Left normal of segment k (rotate the direction a quarter turn counter-clockwise in east, north). */
  const normalOf = (k: number): Vec2 => {
    const d = dirs[k] as Vec2;
    return [-d[1], d[0]];
  };
  const side = (sign: 1 | -1): Vec3[] =>
    oriented.map((p, i): Vec3 => {
      const before = i > 0 ? normalOf(i - 1) : normalOf(0);
      const after = i < n - 1 ? normalOf(i) : normalOf(n - 2);
      const m = unit(before[0] + after[0], before[1] + after[1]);
      const cos = Math.max(m[0] * after[0] + m[1] * after[1], 1 / MAX_MITER);
      const scale = (sign * radiusM) / cos;
      return [p[0] + m[0] * scale, p[1] + m[1] * scale, p[2]];
    });
  const up = side(1);
  const down = side(-1);

  const dTop = dirs[n - 2] as Vec2;
  const nTop = normalOf(n - 2);
  const dBottom = dirs[0] as Vec2;
  const nBottom = normalOf(0);
  const top = oriented[n - 1] as Vec3;
  const bottom = oriented[0] as Vec3;
  const arc = (centre: Vec3, normal: Vec2, dir: Vec2, sign: 1 | -1): Vec3[] => {
    const out: Vec3[] = [];
    for (let i = 1; i < BULLWHEEL_SEGMENTS; i += 1) {
      const phi = (Math.PI * i) / BULLWHEEL_SEGMENTS;
      const c = Math.cos(phi) * sign;
      const s = Math.sin(phi);
      out.push([
        centre[0] + radiusM * (c * normal[0] + s * dir[0]),
        centre[1] + radiusM * (c * normal[1] + s * dir[1]),
        centre[2],
      ]);
    }
    return out;
  };
  // Up the left rope, over the top wheel (left to right through "ahead"), down the right rope, round the bottom wheel
  // (right to left through "behind", which is -dir, so the arc runs with dir negated).
  const bottomDir: Vec2 = [-dBottom[0], -dBottom[1]];
  const polyline: Vec3[] = [
    ...up,
    ...arc(top, nTop, dTop, 1),
    ...[...down].reverse(),
    ...arc(bottom, [-nBottom[0], -nBottom[1]], bottomDir, 1),
  ];
  polyline.push(polyline[0] as Vec3);
  const cum: number[] = [0];
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1] as Vec3;
    const b = polyline[i] as Vec3;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const length = cum[cum.length - 1] as number;

  const loopPoint = (sRaw: number): LoopPoint => {
    const s = ((sRaw % length) + length) % length;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] as number) <= s) lo = mid;
      else hi = mid;
    }
    const a = polyline[lo] as Vec3;
    const b = polyline[hi] as Vec3;
    const span = (cum[hi] as number) - (cum[lo] as number);
    const t = span === 0 ? 0 : (s - (cum[lo] as number)) / span;
    const tangent = unit(b[0] - a[0], b[1] - a[1]);
    return {
      east: a[0] + t * (b[0] - a[0]),
      north: a[1] + t * (b[1] - a[1]),
      elevation: a[2] + t * (b[2] - a[2]),
      tangentEast: tangent[0],
      tangentNorth: tangent[1],
    };
  };
  return { up, down, length, reversed, loopPoint };
}

/** Number of chairs on a loop: one per spacing, at least one. */
export function chairCount(loopLength: number, spacingM = CHAIR_SPACING_M): number {
  return Math.max(1, Math.floor(loopLength / spacingM));
}

/**
 * One chair as a single merged geometry, origin at the rope grip, hanging down -y and facing +x: a 0.1 x 2.5 m hanger,
 * a seat 1.4 m wide and 0.5 m deep, and a 0.6 m back.
 */
export function buildChairGeometry(): BufferGeometry {
  const hanger = new BoxGeometry(0.1, HANGER_M, 0.1).translate(0, -HANGER_M / 2, 0);
  const seat = new BoxGeometry(0.5, 0.1, 1.4).translate(0.25, -HANGER_M, 0);
  const back = new BoxGeometry(0.1, 0.6, 1.4).translate(-0.05, -HANGER_M + 0.35, 0);
  const merged = mergeGeometries([hanger, seat, back], false);
  for (const part of [hanger, seat, back]) part.dispose();
  return merged;
}

export interface InstallLiftChairsOptions {
  readonly fadeCentre: RadialFadeOptions['centre'];
}

export interface LiftChairsHandle {
  readonly group: Object3D;
  /** The one instanced mesh of every chair of every lift; null when there is no lift. */
  readonly mesh: InstancedMesh | null;
  /** The chair material (radial fade patched; the caller applies the horizon blend). */
  readonly material: Material;
  readonly count: number;
  /** Chair speed in m/s along the rope; 0 freezes the chairs. */
  setSpeed(metresPerSecond: number): void;
  readonly speed: number;
  /**
   * Advances the animation phase by deltaMs (capped at MAX_FRAME_DELTA_MS) and re-places every chair of a visible
   * lift. verticalScale is the ElevatedGroup y scale: the chair is drawn at 1 / verticalScale so it keeps its true
   * size under exaggeration, as the sport billboards do.
   */
  step(deltaMs: number, verticalScale?: number): void;
  dispose(): void;
}

interface LiftRun {
  readonly loop: LiftLoop;
  readonly lines: readonly { readonly visible: boolean }[];
  readonly first: number;
  readonly count: number;
  readonly spacing: number;
  zeroed: boolean;
}

const UP = new Vector3(0, 1, 0);

/** Builds the chair instances for every lift in the registry (entries with a loop), hidden never; follows each lift's lines' visibility. */
export function installLiftChairs(
  parent: Object3D,
  entries: Iterable<AreaEntry>,
  toScene: SceneMapper,
  options: InstallLiftChairsOptions,
): LiftChairsHandle {
  const runs: LiftRun[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.lift === undefined) continue;
    const count = chairCount(entry.lift.length);
    runs.push({
      loop: entry.lift,
      lines: entry.lines,
      first: total,
      count,
      spacing: entry.lift.length / count,
      zeroed: false,
    });
    total += count;
  }
  const material = new MeshStandardMaterial({ color: 0x3b3d40, roughness: 0.9, metalness: 0 });
  applyRadialFade(material, { centre: options.fadeCentre });
  const geometry = buildChairGeometry();
  const mesh = total > 0 ? new InstancedMesh(geometry, material, total) : null;
  if (mesh) {
    mesh.name = 'lift-chairs';
    // The chairs move along the loops every frame, so the construction-time bounds would cull them.
    mesh.frustumCulled = false;
    parent.add(mesh);
  }
  let speed = CHAIR_SPEED_MPS;
  let phase = 0;
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const matrix = new Matrix4();
  const hidden = new Matrix4().makeScale(0, 0, 0);

  return {
    group: mesh ?? parent,
    mesh,
    material,
    count: total,
    get speed() {
      return speed;
    },
    setSpeed(metresPerSecond) {
      speed = Number.isFinite(metresPerSecond) ? Math.max(0, metresPerSecond) : CHAIR_SPEED_MPS;
    },
    step(deltaMs, verticalScale = 1) {
      if (!mesh) return;
      const dt = Math.min(Math.max(deltaMs, 0), MAX_FRAME_DELTA_MS) / 1000;
      phase += speed * dt;
      scale.set(1, 1 / verticalScale, 1);
      for (const run of runs) {
        const visible = run.lines.some((line) => line.visible);
        if (!visible) {
          if (!run.zeroed) {
            for (let i = 0; i < run.count; i += 1) mesh.setMatrixAt(run.first + i, hidden);
            run.zeroed = true;
            mesh.instanceMatrix.needsUpdate = true;
          }
          continue;
        }
        run.zeroed = false;
        for (let i = 0; i < run.count; i += 1) {
          const p = run.loop.loopPoint(phase + i * run.spacing);
          const [x, y, z] = toScene(p.east, p.north, p.elevation);
          position.set(x, y, z);
          // Local +x is the direction of travel; a yaw of theta about +y maps +x to (cos, 0, -sin).
          quaternion.setFromAxisAngle(UP, Math.atan2(p.tangentNorth, p.tangentEast));
          matrix.compose(position, quaternion, scale);
          mesh.setMatrixAt(run.first + i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      if (mesh) {
        parent.remove(mesh);
        mesh.dispose();
      }
      geometry.dispose();
      material.dispose();
    },
  };
}

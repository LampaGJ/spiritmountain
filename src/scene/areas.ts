import { Group, type Scene } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Area, AreaKind } from '../schema/area';
import { cableLine, drapeLine, liftOffsetM, minClearance, type Vec3 } from './drape';
import type { MeshSurface } from './heightfield';
import { AREA_KIND_COLOR, LINE_WIDTH_PX } from './palette';

/**
 * Maps a local-metre position (east, north, elevation in world metres, BEFORE vertical
 * exaggeration) to three.js scene coordinates. The production mapper wraps toScene from
 * src/scene/frame.ts (#11), which owns the axis convention and VERTICAL_EXAGGERATION.
 * Lift offsets and DRAPE_LIFT_M are added to elevation before this function runs.
 */
export type SceneMapper = (
  east: number,
  north: number,
  elevation: number,
) => readonly [number, number, number];

export interface AreaPolylines {
  readonly areaId: string;
  /** One entry per drawn line (one per polygon ring), world metres. */
  readonly world: Vec3[][];
  /** The same lines in scene coordinates as flat x, y, z arrays. */
  readonly scene: number[][];
  readonly clampedCount: number;
  /** Smallest cable clearance above the mesh for a lift; null for every other kind. */
  readonly liftMinClearanceM: number | null;
}

function closeRing(
  ring: ReadonlyArray<ReadonlyArray<number>>,
): ReadonlyArray<ReadonlyArray<number>> {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined || last === undefined) return ring;
  const closed = first[0] === last[0] && first[1] === last[1];
  return closed ? ring : [...ring, first];
}

/** Pure positions builder: no three objects, so it tests in node. */
export function buildAreaPositions(
  area: Area,
  surface: MeshSurface,
  toScene: SceneMapper,
): AreaPolylines {
  const world: Vec3[][] = [];
  let clampedCount = 0;
  let liftMinClearanceM: number | null = null;

  if (area.kind === 'lift') {
    if (area.geometry.type !== 'LineString') {
      throw new Error(`area ${area.id}: a lift must be a LineString, got ${area.geometry.type}`);
    }
    const cable = cableLine(surface, area.geometry.coordinates, liftOffsetM(area.id, area.osmTags));
    world.push(cable.points);
    clampedCount += cable.clampedCount;
    liftMinClearanceM = minClearance(surface, cable.points);
  } else {
    const lines =
      area.geometry.type === 'LineString'
        ? [area.geometry.coordinates]
        : area.geometry.coordinates.map((ring) => closeRing(ring));
    for (const line of lines) {
      const draped = drapeLine(surface, line);
      world.push(draped.points);
      clampedCount += draped.clampedCount;
    }
  }

  const scene = world.map((points) => {
    if (points.length < 2) {
      throw new Error(
        `area ${area.id}: a line needs at least 2 distinct points, got ${points.length}`,
      );
    }
    return points.flatMap(([east, north, elevation]) => [...toScene(east, north, elevation)]);
  });
  return { areaId: area.id, world, scene, clampedCount, liftMinClearanceM };
}

/**
 * @displayName Area line registry entry
 * @strategicPurpose Hands #13 (picking) and #14 (filters) one lookup from area id to the area and
 *   every Line2 drawn for it, so neither re-derives identity from geometry.
 * @tacticalObjective Maps areaId to { area, lines }. A polygon with holes has one Line2 per ring,
 *   all with userData.areaId equal to the key.
 */
export interface AreaEntry {
  readonly area: Area;
  readonly lines: readonly Line2[];
}

export interface AreaLayerStats {
  readonly lineCount: number;
  readonly clampedVertexCount: number;
  /** Smallest lift cable clearance over all lifts; null when there are no lifts. */
  readonly liftMinClearanceM: number | null;
}

export interface AreaLayer {
  readonly group: Group;
  readonly registry: ReadonlyMap<string, AreaEntry>;
  readonly materials: Readonly<Record<AreaKind, LineMaterial>>;
  readonly stats: AreaLayerStats;
  /**
   * Rewrites every non-lift line's positions in place from another surface (the composite from surfaceSampler, or the
   * bare-earth mesh surface to restore). Line2 objects, userData.areaId and visibility are kept. Lifts keep their straight cables.
   */
  redrape(surface: MeshSurface): void;
}

/**
 * Build the Line2 objects. Needs no renderer. Throws on a duplicate area id.
 * Resolution note: LineSegments2.onBeforeRender overwrites material.resolution from the renderer
 * viewport on every draw, so no resize handler is needed for drawing. The initial value only
 * matters for raycasting before the first frame (LineSegments2.raycast returns early at 0).
 */
export function buildAreaLayer(
  areas: readonly Area[],
  surface: MeshSurface,
  toScene: SceneMapper,
  resolution: { readonly width: number; readonly height: number },
): AreaLayer {
  const materials = {} as Record<AreaKind, LineMaterial>;
  for (const kind of Object.keys(AREA_KIND_COLOR) as AreaKind[]) {
    const material = new LineMaterial({ color: AREA_KIND_COLOR[kind], linewidth: LINE_WIDTH_PX });
    material.resolution.set(resolution.width, resolution.height);
    materials[kind] = material;
  }

  const group = new Group();
  group.name = 'areas';
  const registry = new Map<string, AreaEntry>();
  let lineCount = 0;
  let clampedVertexCount = 0;
  let liftMinClearanceM: number | null = null;

  for (const area of areas) {
    if (registry.has(area.id)) throw new Error(`duplicate area id ${area.id}`);
    const built = buildAreaPositions(area, surface, toScene);
    const lines = built.scene.map((positions) => {
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const line = new Line2(geometry, materials[area.kind]);
      line.name = area.id;
      line.userData['areaId'] = area.id;
      group.add(line);
      return line;
    });
    registry.set(area.id, { area, lines });
    lineCount += lines.length;
    clampedVertexCount += built.clampedCount;
    if (built.liftMinClearanceM !== null) {
      liftMinClearanceM = Math.min(
        liftMinClearanceM ?? Number.POSITIVE_INFINITY,
        built.liftMinClearanceM,
      );
    }
  }
  const redrape = (next: MeshSurface): void => {
    for (const { area, lines } of registry.values()) {
      if (area.kind === 'lift') continue;
      const built = buildAreaPositions(area, next, toScene);
      built.scene.forEach((positions, i) => {
        (lines[i] as Line2).geometry.setPositions(positions);
      });
    }
  };
  return {
    group,
    registry,
    materials,
    stats: { lineCount, clampedVertexCount, liftMinClearanceM },
    redrape,
  };
}

/** Wire the layer into a scene and report, once, anything that makes the drape suspect. */
export function installAreas(
  scene: Scene,
  areas: readonly Area[],
  surface: MeshSurface,
  toScene: SceneMapper,
): AreaLayer {
  const layer = buildAreaLayer(areas, surface, toScene, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  scene.add(layer.group);
  const { stats } = layer;
  if (stats.clampedVertexCount > 0) {
    console.warn(
      `areas: ${stats.clampedVertexCount} line vertices lie outside the terrain and were clamped to its edge; check the frame origin`,
    );
  }
  if (stats.liftMinClearanceM !== null && stats.liftMinClearanceM < 0) {
    console.warn(
      `areas: a lift cable passes ${(-stats.liftMinClearanceM).toFixed(2)} m below the terrain surface`,
    );
  }
  return layer;
}

import { Group, type Object3D } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Annotation } from '../schema/annotation';
import type { Area } from '../schema/area';
import {
  cableLine,
  drapeLine,
  LINE_SPACING_M,
  liftOffsetM,
  minClearance,
  offsetPolyline,
  smoothPolyline,
  type Vec3,
} from './drape';
import type { MeshSurface } from './heightfield';
import { SPORT_COLOR } from './palette';
import { sportForArea, type Activity } from './sport-routing';

/** Default width of one sport band in px (#54); the DEBUG slider changes it live. Strands sit one band-width apart. */
export const DEFAULT_LINE_WIDTH_PX = 6;

/**
 * Declares the per-material screen-space strand shift (#54). The shift moves a strand sideways by uStrandShift pixels
 * along the Line2 screen normal, so neighbouring bands of width w and shift factors differing by 1 touch at any zoom.
 */
const SHIFT_UNIFORM = 'uStrandShift';
const SHIFT_DECLARATION_ANCHOR = 'uniform float linewidth;';
const SHIFT_SIGN_ANCHOR = '// sign flip';
const SHIFT_APPLY_ANCHOR = 'clip.xy += offset;';

/**
 * Returns the LineMaterial vertex shader with a uStrandShift pixel offset along the screen normal, or null when
 * three's shader no longer contains the anchors this patch needs (the layer then falls back to world-space strands).
 */
export function patchStrandShader(vertexShader: string): string | null {
  if (
    !vertexShader.includes(SHIFT_DECLARATION_ANCHOR) ||
    !vertexShader.includes(SHIFT_SIGN_ANCHOR) ||
    vertexShader.split(SHIFT_APPLY_ANCHOR).length !== 2
  ) {
    return null;
  }
  return vertexShader
    .replace(
      SHIFT_DECLARATION_ANCHOR,
      `${SHIFT_DECLARATION_ANCHOR}\n\t\tuniform float ${SHIFT_UNIFORM};`,
    )
    .replace(SHIFT_SIGN_ANCHOR, `vec2 strandNormal = offset;\n\t\t\t\t${SHIFT_SIGN_ANCHOR}`)
    .replace(
      SHIFT_APPLY_ANCHOR,
      `clip.xy += offset + strandNormal * ${SHIFT_UNIFORM} * 2.0 / resolution.y * clip.w;`,
    );
}

/** Opacity of the ghost pass that shows an occluded stretch of a line through whatever hides it. */
export const GHOST_OPACITY = 0.35;
/** The ghost draws after every default-order object, including the fade-transparent ground meshes. */
export const GHOST_RENDER_ORDER = 1;

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

export interface BuildOptions {
  /** One sideways plan offset per strand of a LineString (world metres); default one strand on the centreline. */
  readonly strandOffsetsM?: readonly number[];
  /** Resample a non-lift LineString through a Catmull-Rom spline before draping (#54). Default off here. */
  readonly smooth?: boolean;
}

/** Pure positions builder: no three objects, so it tests in node. */
export function buildAreaPositions(
  area: Area,
  surface: MeshSurface,
  toScene: SceneMapper,
  options: BuildOptions = {},
): AreaPolylines {
  const { strandOffsetsM = [0], smooth = false } = options;
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
    let lines: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
    if (area.geometry.type === 'LineString') {
      const centre = smooth ? smoothPolyline(area.geometry.coordinates) : area.geometry.coordinates;
      lines = strandOffsetsM.map((offset) =>
        offset === 0 ? centre : offsetPolyline(centre, offset),
      );
    } else {
      lines = area.geometry.coordinates.map((ring) => closeRing(ring));
    }
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
  /** Mutable in place: applyStrands appends the extra strands of a multi-sport trail to the same array. */
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
  /** One shared solid material per sport, coloured from SPORT_COLOR. */
  readonly materials: Readonly<Record<Activity, LineMaterial>>;
  /** The no-depth-test ghost pass materials, one per sport (see GHOST_OPACITY). */
  readonly ghostMaterials: Readonly<Record<Activity, LineMaterial>>;
  readonly stats: AreaLayerStats;
  /**
   * Rewrites every non-lift line's positions in place from another surface (the composite from surfaceSampler, or the
   * bare-earth mesh surface to restore). Line2 objects, userData.areaId and visibility are kept. Lifts keep their straight cables.
   */
  redrape(surface: MeshSurface): void;
  /**
   * Re-colours every line by sport (sportForArea) for the current annotations and Activity selection. Swaps shared
   * per-sport materials only: never rebuilds geometry, adds or removes a Line2, or touches the ghost renderOrder or
   * raycast. Records the sport material in line.userData.baseMaterial; a line currently highlighted (its material is
   * not the recorded base) keeps its highlight, and the highlighter restores the new base later. Idempotent.
   */
  route(annotations: ReadonlyMap<string, Annotation>, selected: ReadonlySet<Activity>): void;
  /**
   * 'screen': strands are offset in pixels by the patched LineMaterial shader and stay touching at any zoom.
   * 'world': the shader patch failed, so strands are offset strandSpacing metres in plan instead.
   */
  readonly strandMode: 'screen' | 'world';
  /**
   * Gives every non-lift LineString annotated with k >= 2 activities k strands (one Line2 each, in the same entry
   * array, userData.activity set), once annotations are known. Idempotent. Polygons and lifts are untouched.
   */
  applyStrands(annotations: ReadonlyMap<string, Annotation>): void;
  /** Sets the band width in px on every solid and ghost material in place; screen strand shifts follow. */
  setLineWidth(px: number): void;
  /** World-mode fallback only: re-offsets and re-drapes the strands metres apart. No effect in screen mode. */
  setStrandSpacing(metres: number): void;
  /** Turns Catmull-Rom smoothing of non-lift LineStrings on or off and re-drapes them. On by default. */
  setSmooth(on: boolean): void;
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
  const materials = {} as Record<Activity, LineMaterial>;
  const ghostMaterials = {} as Record<Activity, LineMaterial>;
  const allMaterials: LineMaterial[] = [];
  let widthPx = DEFAULT_LINE_WIDTH_PX;
  let smooth = true;
  let spacingM = LINE_SPACING_M;
  let currentSurface = surface;
  const patched = patchStrandShader(new LineMaterial().vertexShader);
  const strandMode: 'screen' | 'world' = patched === null ? 'world' : 'screen';
  if (patched === null) {
    console.warn(
      'areas: LineMaterial shader patch failed; strands fall back to world-space offsets',
    );
  }
  /** Adds the strand-shift uniform and patched shader to a base material (screen mode only). */
  const prepare = (material: LineMaterial): LineMaterial => {
    material.userData['factor'] = 0;
    if (patched !== null) {
      material.vertexShader = patched;
      material.uniforms[SHIFT_UNIFORM] = { value: 0 };
    }
    allMaterials.push(material);
    return material;
  };
  for (const sport of Object.keys(SPORT_COLOR) as Activity[]) {
    const material = prepare(new LineMaterial({ color: SPORT_COLOR[sport], linewidth: widthPx }));
    material.resolution.set(resolution.width, resolution.height);
    // The line sits 0.5 m above the surface; a constant depth bias (units only, no slope term) keeps it drawn over the
    // terrain at grazing angles, where depth error would otherwise push it behind the ground.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 0;
    material.polygonOffsetUnits = -4;
    materials[sport] = material;
    // The ghost pass (#36): the same line drawn faint with no depth test, so a trail hidden behind a ridge, a LiDAR tree
    // crown or a simulated tree still reads as a trace. The solid pass above keeps the depth cue where it is in view.
    const ghost = prepare(
      new LineMaterial({
        color: SPORT_COLOR[sport],
        linewidth: widthPx,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthTest: false,
        depthWrite: false,
      }),
    );
    ghost.resolution.set(resolution.width, resolution.height);
    ghostMaterials[sport] = ghost;
  }

  const group = new Group();
  group.name = 'areas';
  const registry = new Map<string, AreaEntry>();
  let lineCount = 0;
  let clampedVertexCount = 0;
  let liftMinClearanceM: number | null = null;

  /** Areas drawn as k >= 2 strands, with the activity of each strand in order. */
  const strandPlan = new Map<string, readonly Activity[]>();
  const optionsFor = (area: Area): BuildOptions => {
    const plan = strandPlan.get(area.id);
    if (plan === undefined) return { smooth };
    const offsets = plan.map((_, i) =>
      strandMode === 'world' ? (i - (plan.length - 1) / 2) * spacingM : 0,
    );
    return { smooth, strandOffsetsM: offsets };
  };
  const makeLine = (area: Area, positions: number[], sport: Activity): Line2 => {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, materials[sport]);
    line.name = area.id;
    line.userData['areaId'] = area.id;
    line.userData['baseMaterial'] = materials[sport];
    // The ghost is a child so it follows the line's visibility and shares its geometry (redrape moves both). It
    // renders after the fade-transparent ground meshes and never intercepts a pick ray.
    const ghost = new Line2(geometry, ghostMaterials[sport]);
    ghost.name = `${area.id}:ghost`;
    ghost.renderOrder = GHOST_RENDER_ORDER;
    ghost.raycast = () => {};
    line.add(ghost);
    group.add(line);
    return line;
  };
  /** The solid or ghost material for a sport at a screen-shift factor (in band widths); one clone per distinct factor. */
  const variants = new Map<string, LineMaterial>();
  const variant = (sport: Activity, factor: number, isGhost: boolean): LineMaterial => {
    const base = isGhost ? ghostMaterials[sport] : materials[sport];
    if (factor === 0 || strandMode === 'world') return base;
    const key = `${isGhost ? 'g' : 's'}|${sport}|${factor}`;
    let material = variants.get(key);
    if (material === undefined) {
      material = base.clone();
      material.userData['factor'] = factor;
      material.uniforms[SHIFT_UNIFORM] = { value: factor * widthPx };
      allMaterials.push(material);
      variants.set(key, material);
    }
    return material;
  };

  for (const area of areas) {
    if (registry.has(area.id)) throw new Error(`duplicate area id ${area.id}`);
    const built = buildAreaPositions(area, surface, toScene, { smooth });
    // First paint uses the kind default: annotations load after the layer, and the first filter apply re-routes.
    const sport = sportForArea(area, undefined, new Set());
    const lines = built.scene.map((positions) => makeLine(area, positions, sport));
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
  const rebuildAll = (): void => {
    for (const { area, lines } of registry.values()) {
      if (area.kind === 'lift') continue;
      const built = buildAreaPositions(area, currentSurface, toScene, optionsFor(area));
      built.scene.forEach((positions, i) => {
        (lines[i] as Line2).geometry.setPositions(positions);
      });
    }
  };
  const redrape = (next: MeshSurface): void => {
    currentSurface = next;
    rebuildAll();
  };
  const setStrandMaterials = (line: Line2, activity: Activity, factor: number): void => {
    const solid = variant(activity, factor, false);
    const previous = line.userData['baseMaterial'] as LineMaterial | undefined;
    if (previous === undefined || line.material === previous) line.material = solid;
    line.userData['baseMaterial'] = solid;
    const ghost = line.children[0];
    if (ghost instanceof Line2) ghost.material = variant(activity, factor, true);
  };
  const applyStrands = (annotations: ReadonlyMap<string, Annotation>): void => {
    for (const [areaId, entry] of registry) {
      const { area } = entry;
      if (area.kind === 'lift' || area.geometry.type !== 'LineString') continue;
      const activities = [
        ...new Set((annotations.get(areaId)?.activities ?? []).map((a) => a.activity)),
      ];
      if (activities.length < 2) continue;
      strandPlan.set(areaId, activities);
      const lines = entry.lines as Line2[];
      const built = buildAreaPositions(area, currentSurface, toScene, optionsFor(area));
      built.scene.forEach((positions, i) => {
        const activity = activities[i] as Activity;
        let line = lines[i];
        if (line === undefined) {
          line = makeLine(area, positions, activity);
          lines.push(line);
        } else {
          line.geometry.setPositions(positions);
        }
        const factor = strandMode === 'screen' ? i - (activities.length - 1) / 2 : 0;
        line.userData['activity'] = activity;
        line.userData['strandFactor'] = factor;
        setStrandMaterials(line, activity, factor);
      });
    }
  };
  const setLineWidth = (px: number): void => {
    widthPx = px;
    for (const material of allMaterials) {
      material.linewidth = px;
      const shift = material.uniforms[SHIFT_UNIFORM];
      if (shift) shift.value = (material.userData['factor'] as number) * px;
    }
  };
  const setStrandSpacing = (metres: number): void => {
    spacingM = metres;
    if (strandMode === 'world') rebuildAll();
  };
  const setSmooth = (on: boolean): void => {
    smooth = on;
    rebuildAll();
  };
  const route = (
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
  ): void => {
    for (const [areaId, { area, lines }] of registry) {
      const sport = sportForArea(area, annotations.get(areaId), selected);
      for (const line of lines) {
        const strand = line.userData['activity'] as Activity | undefined;
        if (strand !== undefined) {
          setStrandMaterials(line, strand, line.userData['strandFactor'] as number);
          // applyFilter has already set the area's visibility; a strand whose sport is off hides on top of that.
          if (selected.size > 0 && !selected.has(strand)) line.visible = false;
          continue;
        }
        const previous = line.userData['baseMaterial'] as LineMaterial | undefined;
        if (previous === undefined || line.material === previous) line.material = materials[sport];
        line.userData['baseMaterial'] = materials[sport];
        const ghost = line.children[0];
        if (ghost instanceof Line2) ghost.material = ghostMaterials[sport];
      }
    }
  };
  return {
    group,
    registry,
    materials,
    ghostMaterials,
    stats: { lineCount, clampedVertexCount, liftMinClearanceM },
    redrape,
    route,
    strandMode,
    applyStrands,
    setLineWidth,
    setStrandSpacing,
    setSmooth,
  };
}

/** Wire the layer into a scene and report, once, anything that makes the drape suspect. */
export function installAreas(
  scene: Object3D,
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

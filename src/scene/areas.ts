import { Group, type Material, type Mesh, type Object3D } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Annotation } from '../schema/annotation';
import type { Area } from '../schema/area';
import {
  buildCurtain,
  canopyProfile,
  createCurtainMaterial,
  createCurtainMesh,
  curtainStripes,
  mergeCurtains,
  type CanopyAt,
  type Curtain,
} from './curtain';
import {
  cableLine,
  DRAPE_LIFT_M,
  drapeLine,
  LINE_SPACING_M,
  MAX_STEP_M,
  liftOffsetM,
  minClearance,
  offsetPolyline,
  smoothPolyline,
  type Vec3,
} from './drape';
import { applyRadialFade, setFadeCentre, type RadialFadeUniforms } from './fade';
import type { MeshSurface } from './heightfield';
import { buildLiftLoop, type LiftLoop } from './lifts';
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
  /** The haul-rope loop of a lift (#68); null for every other kind. world and scene hold its two rope lines. */
  readonly lift: LiftLoop | null;
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
  /**
   * Lift above the surface per vertex of a non-lift LineString's (resampled) centreline, for every strand (#64: the
   * curtain top). Default DRAPE_LIFT_M everywhere. Polygons and lifts ignore it.
   */
  readonly liftsFor?: (centre: ReadonlyArray<ReadonlyArray<number>>) => readonly number[];
}

/** Pure positions builder: no three objects, so it tests in node. */
export function buildAreaPositions(
  area: Area,
  surface: MeshSurface,
  toScene: SceneMapper,
  options: BuildOptions = {},
): AreaPolylines {
  const { strandOffsetsM = [0], smooth = false, liftsFor } = options;
  const world: Vec3[][] = [];
  let clampedCount = 0;
  let liftMinClearanceM: number | null = null;
  let lift: LiftLoop | null = null;

  if (area.kind === 'lift') {
    if (area.geometry.type !== 'LineString') {
      throw new Error(`area ${area.id}: a lift must be a LineString, got ${area.geometry.type}`);
    }
    const cable = cableLine(surface, area.geometry.coordinates, liftOffsetM(area.id, area.osmTags));
    // Two rope lines replace the centre cable (#68), both in the cable's own vertex order, one per side.
    const loop = buildLiftLoop(cable.points);
    lift = loop;
    const ropes = [loop.up, loop.down];
    for (const rope of loop.reversed ? ropes.map((r) => [...r].reverse()) : ropes) {
      world.push([...rope]);
    }
    clampedCount += cable.clampedCount;
    liftMinClearanceM = minClearance(surface, cable.points);
  } else {
    let lines: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
    let lifts: number | readonly number[] = DRAPE_LIFT_M;
    if (area.geometry.type === 'LineString') {
      const centre = smooth ? smoothPolyline(area.geometry.coordinates) : area.geometry.coordinates;
      // offsetPolyline keeps the vertex count, so one lift array serves every strand.
      if (liftsFor) lifts = liftsFor(centre);
      lines = strandOffsetsM.map((offset) =>
        offset === 0 ? centre : offsetPolyline(centre, offset),
      );
    } else {
      lines = area.geometry.coordinates.map((ring) => closeRing(ring));
    }
    for (const line of lines) {
      const draped = drapeLine(surface, line, MAX_STEP_M, lifts);
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
  return { areaId: area.id, world, scene, clampedCount, liftMinClearanceM, lift };
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
  /** The wall under a non-lift LineString when the layer was built with curtains (#64); never picked. */
  readonly curtain?: Curtain;
  /** The haul-rope loop of a lift (#68), which the chair animation rides; absent for every other kind. */
  readonly lift?: LiftLoop;
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
  readonly stats: AreaLayerStats;
  /**
   * Rewrites every non-lift line's positions in place from another surface (the composite from surfaceSampler, or the
   * bare-earth mesh surface to restore). Line2 objects, userData.areaId and visibility are kept. Lifts keep their straight cables.
   */
  redrape(surface: MeshSurface): void;
  /**
   * Re-colours every line by sport (sportForArea) for the current annotations and Activity selection. Swaps shared
   * per-sport materials only: never rebuilds geometry, adds or removes a Line2, or touches renderOrder or
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
  /** Sets the band width in px on every material in place; screen strand shifts follow. */
  setLineWidth(px: number): void;
  /** World-mode fallback only: re-offsets and re-drapes the strands metres apart. No effect in screen mode. */
  setStrandSpacing(metres: number): void;
  /** Turns Catmull-Rom smoothing of non-lift LineStrings on or off and re-drapes them. On by default. */
  setSmooth(on: boolean): void;
  /** The radial-faded curtain material (#64), for the caller's horizon blend; empty without curtains. */
  readonly curtainMaterials: readonly Material[];
  /** The one mesh every visible curtain is merged into; null without curtains. */
  readonly curtainMesh: Mesh | null;
  /** Moves the radial fade centre of the curtain material. */
  setCurtainFadeCentre(centre: { readonly east: number; readonly north: number }): void;
  /** Sets the canopy height source (null: CURTAIN_MIN_M everywhere) and re-drapes the trails onto the new curtain tops. */
  setCanopy(canopyAt: CanopyAt | null): void;
  /** DEBUG: scales the curtain height (0 to 2, default 1) and re-drapes. */
  setCurtainScale(k: number): void;
  /** DEBUG: curtains off hides the walls and drapes the lines back onto the surface. */
  setCurtainsOn(on: boolean): void;
  /** Height of the curtain top at a plan point (bare earth plus canopy), or -Infinity with curtains off or absent. */
  trailTopHeight(east: number, north: number): number;
}

export interface AreaLayerOptions {
  /** Build a curtain under every non-lift LineString and drape its lines on the curtain top (#64). Default off. */
  readonly curtains?: boolean;
}

/** The curtain-top source of the last layer built with curtains; billboards.ts anchors trail signs on it. */
let activeTrailTop: ((east: number, north: number) => number) | null = null;

/**
 * Height of the trail curtain top (bare earth plus canopy) at a plan point, from the last area layer built with
 * curtains, or -Infinity when there is none or its curtains are off. The trail sign anchor takes the larger of this and
 * the active surface, so its tail lands on the top edge of the curtain.
 */
export function trailTopHeight(east: number, north: number): number {
  return activeTrailTop === null ? Number.NEGATIVE_INFINITY : activeTrailTop(east, north);
}

/**
 * The plan offsets a point's canopy is sampled at for trailTopHeight: a cross of the CURTAIN_SMOOTH_VERTICES window at
 * the 5 m resample (plus or minus 10 m), standing in for the moving maximum along a line the point is not tied to.
 */
const TOP_PROBE_M: readonly (readonly [number, number])[] = [
  [0, 0],
  [10, 0],
  [-10, 0],
  [0, 10],
  [0, -10],
];

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
  layerOptions: AreaLayerOptions = {},
): AreaLayer {
  const materials = {} as Record<Activity, LineMaterial>;
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
    // Opaque and depth-tested (#57): trees and terrain occlude the line, and the line writes depth itself.
    const material = prepare(
      new LineMaterial({
        color: SPORT_COLOR[sport],
        linewidth: widthPx,
        transparent: false,
        opacity: 1,
        depthTest: true,
        depthWrite: true,
      }),
    );
    material.resolution.set(resolution.width, resolution.height);
    // The line sits 0.5 m above the surface; a constant depth bias (units only, no slope term) keeps it drawn over the
    // terrain at grazing angles, where depth error would otherwise push it behind the ground.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 0;
    material.polygonOffsetUnits = -4;
    materials[sport] = material;
  }

  const group = new Group();
  group.name = 'areas';
  const registry = new Map<string, AreaEntry>();
  let lineCount = 0;
  let clampedVertexCount = 0;
  let liftMinClearanceM: number | null = null;

  // ---- curtains (#64) ----
  const curtainsBuilt = layerOptions.curtains === true;
  let curtainsOn = curtainsBuilt;
  let canopyAt: CanopyAt | null = null;
  let curtainScale = 1;
  /** Curtains stand on the bare earth the layer was built on, whatever surface the lines are re-draped onto. */
  const bareAt = (east: number, north: number): number => surface.sample(east, north).height;
  const curtainMaterial = curtainsBuilt ? createCurtainMaterial() : null;
  const curtainFades: RadialFadeUniforms[] = [];
  const curtainMaterials: Material[] = [];
  if (curtainMaterial) {
    const centre = { east: surface.extent.centreEast, north: surface.extent.centreNorth };
    curtainFades.push(applyRadialFade(curtainMaterial, { centre }));
    curtainMaterials.push(curtainMaterial);
  }
  /** Every curtain drawn in one call: the merge of the visible areas' walls, rebuilt on each change. */
  const curtainMesh = curtainMaterial ? createCurtainMesh(curtainMaterial) : null;
  /**
   * Lift per centreline vertex: the curtain top (bare earth plus canopy) above whatever surface the line is draped on,
   * never below that surface, plus DRAPE_LIFT_M. On bare earth that is canopy plus DRAPE_LIFT_M.
   */
  const liftsFor = (centre: ReadonlyArray<ReadonlyArray<number>>): number[] => {
    const profile = canopyProfile(centre, canopyAt, curtainScale);
    return centre.map((p, i) => {
      const east = p[0] as number;
      const north = p[1] as number;
      const top = bareAt(east, north) + (profile[i] as number);
      return DRAPE_LIFT_M + Math.max(0, top - currentSurface.sample(east, north).height);
    });
  };
  const trailTop = (east: number, north: number): number => {
    if (!curtainsOn) return Number.NEGATIVE_INFINITY;
    const probes = TOP_PROBE_M.map(([de, dn]) => [east + de, north + dn]);
    return bareAt(east, north) + Math.max(...canopyProfile(probes, canopyAt, curtainScale));
  };
  if (curtainsBuilt) activeTrailTop = trailTop;

  /** Areas drawn as k >= 2 strands, with the activity of each strand in order. */
  const strandPlan = new Map<string, readonly Activity[]>();
  const optionsFor = (area: Area): BuildOptions => {
    const lift = curtainsOn ? { liftsFor } : {};
    const plan = strandPlan.get(area.id);
    if (plan === undefined) return { smooth, ...lift };
    const offsets = plan.map((_, i) =>
      strandMode === 'world' ? (i - (plan.length - 1) / 2) * spacingM : 0,
    );
    return { smooth, strandOffsetsM: offsets, ...lift };
  };
  /** A curtain for a non-lift LineString, one stripe in the kind default until the first route. */
  const curtainFor = (area: Area, built: AreaPolylines): Curtain | undefined => {
    if (!curtainMesh || area.kind === 'lift' || area.geometry.type !== 'LineString') {
      return undefined;
    }
    const world = built.world[0];
    if (world === undefined) return undefined;
    const curtain = buildCurtain(area.id, world, bareAt, toScene);
    curtain.setStripes([sportForArea(area, undefined, new Set())]);
    return curtain;
  };
  const makeLine = (area: Area, positions: number[], sport: Activity): Line2 => {
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, materials[sport]);
    line.name = area.id;
    line.userData['areaId'] = area.id;
    line.userData['baseMaterial'] = materials[sport];
    group.add(line);
    return line;
  };
  /** The material for a sport at a screen-shift factor (in band widths); one clone per distinct factor. */
  const variants = new Map<string, LineMaterial>();
  const variant = (sport: Activity, factor: number): LineMaterial => {
    const base = materials[sport];
    if (factor === 0 || strandMode === 'world') return base;
    const key = `${sport}|${factor}`;
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
    const built = buildAreaPositions(area, surface, toScene, optionsFor(area));
    // First paint uses the kind default: annotations load after the layer, and the first filter apply re-routes.
    const sport = sportForArea(area, undefined, new Set());
    const lines = built.scene.map((positions) => makeLine(area, positions, sport));
    const curtain = curtainFor(area, built);
    registry.set(area.id, {
      area,
      lines,
      ...(curtain ? { curtain } : {}),
      ...(built.lift ? { lift: built.lift } : {}),
    });
    lineCount += lines.length;
    clampedVertexCount += built.clampedCount;
    if (built.liftMinClearanceM !== null) {
      liftMinClearanceM = Math.min(
        liftMinClearanceM ?? Number.POSITIVE_INFINITY,
        built.liftMinClearanceM,
      );
    }
  }
  /** Re-merges the visible curtains into the one drawn mesh, and shows it only while curtains are on. */
  const refreshCurtains = (): void => {
    if (!curtainMesh) return;
    curtainMesh.geometry.dispose();
    const curtains = [...registry.values()].flatMap((e) => (e.curtain ? [e.curtain] : []));
    curtainMesh.geometry = mergeCurtains(curtains);
    curtainMesh.visible = curtainsOn;
  };
  if (curtainMesh) {
    group.add(curtainMesh);
    refreshCurtains();
  }
  /** Re-shapes an area's curtain under its first (centre) line. */
  const syncCurtain = (entry: AreaEntry, built: AreaPolylines): void => {
    const world = built.world[0];
    if (entry.curtain && world !== undefined) entry.curtain.setLine(world, bareAt);
  };
  const rebuildAll = (): void => {
    for (const entry of registry.values()) {
      const { area, lines } = entry;
      if (area.kind === 'lift') continue;
      const built = buildAreaPositions(area, currentSurface, toScene, optionsFor(area));
      built.scene.forEach((positions, i) => {
        (lines[i] as Line2).geometry.setPositions(positions);
      });
      if (curtainsOn) syncCurtain(entry, built);
    }
    refreshCurtains();
  };
  const redrape = (next: MeshSurface): void => {
    currentSurface = next;
    rebuildAll();
  };
  const setStrandMaterials = (line: Line2, activity: Activity, factor: number): void => {
    const solid = variant(activity, factor);
    const previous = line.userData['baseMaterial'] as LineMaterial | undefined;
    if (previous === undefined || line.material === previous) line.material = solid;
    line.userData['baseMaterial'] = solid;
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
      if (curtainsOn) syncCurtain(entry, built);
    }
    refreshCurtains();
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
    for (const [areaId, { area, lines, curtain }] of registry) {
      const sport = sportForArea(area, annotations.get(areaId), selected);
      if (curtain) {
        // applyFilter has just set every line of the area to the area's visibility; read it before strands hide below.
        curtain.visible = lines.some((line) => line.visible);
        const carried = (annotations.get(areaId)?.activities ?? []).map((a) => a.activity);
        curtain.setStripes(curtainStripes(carried, selected, sport));
      }
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
      }
    }
    refreshCurtains();
  };
  const setCurtainsOn = (on: boolean): void => {
    curtainsOn = curtainsBuilt && on;
    rebuildAll();
  };
  return {
    group,
    registry,
    materials,
    stats: { lineCount, clampedVertexCount, liftMinClearanceM },
    redrape,
    route,
    strandMode,
    applyStrands,
    setLineWidth,
    setStrandSpacing,
    setSmooth,
    curtainMaterials,
    curtainMesh,
    setCurtainFadeCentre(centre) {
      for (const fade of curtainFades) setFadeCentre(fade, centre);
    },
    setCanopy(next) {
      canopyAt = next;
      rebuildAll();
    },
    setCurtainScale(k) {
      curtainScale = k;
      rebuildAll();
    },
    setCurtainsOn,
    trailTopHeight: trailTop,
  };
}

/** Wire the layer into a scene and report, once, anything that makes the drape suspect. */
export function installAreas(
  scene: Object3D,
  areas: readonly Area[],
  surface: MeshSurface,
  toScene: SceneMapper,
  layerOptions: AreaLayerOptions = {},
): AreaLayer {
  const layer = buildAreaLayer(
    areas,
    surface,
    toScene,
    { width: window.innerWidth, height: window.innerHeight },
    layerOptions,
  );
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

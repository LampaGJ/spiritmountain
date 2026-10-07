/**
 * Trail symbols (#38): per activity an abstract SVG shape, extruded to a solid and instanced along every trail through
 * its ribbon, one symbol per tile period, each tall enough to stand clear of the drawn surface. Replaces the PNG tile textures: a map symbol in 3D, not a cartoon.
 *
 * parseSymbolShapes and buildSymbolGeometry are pure three; parseSymbolShapes needs a DOMParser (the browser, or jsdom
 * in tests). The layer (buildSymbolLayer) mirrors RibbonLayer's API so main.ts wires both the same way.
 */
import {
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type Shape,
} from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { Area } from '../schema/area';
import type { Annotation } from '../schema/annotation';
import type { Activity } from '../ui/filter-predicate';
import type { SceneMapper } from './areas';
import { DRAPE_LIFT_M, densify, splitAtAllMeshEdges, type Vec2 } from './drape';
import { applyRadialFade, type RadialFadeOptions } from './fade';
import type { MeshSurface } from './heightfield';
import { SYMBOL_COLOR, TILE_NAMES, type TileInfo, type TileName } from './ribbon-kinds';
import {
  FootprintIndex,
  RIBBON_SINK_M,
  assignTiles,
  linesOf,
  type RibbonAssignment,
} from './ribbons';

/** Least a symbol stands proud of the ribbon top, in metres: its whole height on bare ground with Surface off. */
export const SYMBOL_HEIGHT_M = 0.6;
/**
 * Clearance above the highest active-surface sample under a symbol, in metres. With Surface on a symbol is a column from
 * bare earth up through the LiDAR canopy, standing this far clear of the highest crown under it (#38), so the canopy
 * never buries it.
 */
export const SYMBOL_CLEAR_M = 1.5;
/** Spacing of the centre-line samples used to measure distance along a trail. */
export const SYMBOL_SAMPLE_STEP_M = 1;

type Ring = ReadonlyArray<ReadonlyArray<number>>;

/**
 * The filled shapes of one symbol SVG, in SVG user units (viewBox 0 0 100 100, y down). A path with fill="none" is
 * skipped. Throws when the SVG yields no shape: an empty parse is an error, never an empty list.
 */
export function parseSymbolShapes(svgText: string): Shape[] {
  const loader = new SVGLoader();
  const shapes: Shape[] = [];
  for (const path of loader.parse(svgText).paths) {
    const style = (path.userData as { style?: { fill?: string } } | undefined)?.style;
    if (style?.fill === 'none') continue;
    shapes.push(...SVGLoader.createShapes(path));
  }
  if (shapes.length === 0) throw new Error('symbol SVG has no shape');
  return shapes;
}

export interface SymbolDims {
  /** Metres across the trail that SVG x 0..100 covers. */
  readonly widthM: number;
  /** Metres along the trail that SVG y 0..100 covers: one symbol per period. */
  readonly periodM: number;
  /** Extrusion height in metres. */
  readonly heightM: number;
}

/**
 * Extrudes the shapes and maps them to instance space: SVG x to +x across (x = 50 on the centreline), SVG y to -z
 * along the direction of travel (y = 0 at the instance origin, y = 100 one period ahead), extrusion along +y from 0 to
 * heightM. The map has a positive determinant, so the extrusion's outward winding survives.
 */
export function buildSymbolGeometry(shapes: readonly Shape[], dims: SymbolDims): BufferGeometry {
  const geometry = new ExtrudeGeometry([...shapes], {
    depth: dims.heightM,
    bevelEnabled: false,
    curveSegments: 12,
  });
  const sx = dims.widthM / 100;
  const sz = dims.periodM / 100;
  // Rows: X = sx * svgX - width / 2; Y = extrusion depth; Z = -sz * svgY.
  geometry.applyMatrix4(
    new Matrix4().set(sx, 0, 0, -dims.widthM / 2, 0, 0, 1, 0, 0, -sz, 0, 0, 0, 0, 0, 1),
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A polyline with its cumulative horizontal length, for point lookup by distance along it. */
interface Measured {
  readonly xy: Vec2[];
  readonly cumulative: number[];
}

function measure(line: ReadonlyArray<Readonly<Vec2>>): Measured {
  const xy = densify(line, SYMBOL_SAMPLE_STEP_M);
  const cumulative: number[] = [0];
  for (let k = 1; k < xy.length; k += 1) {
    const a = xy[k - 1] as Vec2;
    const b = xy[k] as Vec2;
    cumulative.push((cumulative[k - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { xy, cumulative };
}

/** The point at distance d along the line (clamped to its ends) and the direction of the segment holding it. */
function pointAt(m: Measured, d: number): { p: Vec2; dir: Vec2 } {
  const { xy, cumulative } = m;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cumulative[mid] as number) <= d) lo = mid;
    else hi = mid;
  }
  const a = xy[lo] as Vec2;
  const b = xy[hi] as Vec2;
  const c0 = cumulative[lo] as number;
  const len = (cumulative[hi] as number) - c0;
  const t = len > 0 ? Math.min(1, Math.max(0, (d - c0) / len)) : 0;
  const dir: Vec2 = len > 0 ? [(b[0] - a[0]) / len, (b[1] - a[1]) / len] : [1, 0];
  return { p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], dir };
}

const UP = new Vector3(0, 1, 0);

/**
 * The instance matrices for one centre line: one symbol per period, centred at period / 2 + i * period, as many as fit
 * whole (floor(length / period)). Stations over a footprint are skipped.
 *
 * Each symbol is a column (the geometry has unit height, scaled per instance). Its base is bare earth minus
 * RIBBON_SINK_M at the station, inside the ribbon slab. Its top is SYMBOL_HEIGHT_M above the ribbon top, or, when the
 * active surface is not bare earth, SYMBOL_CLEAR_M above the highest active sample over its footprint (a 3 x 3 grid
 * spanning widthM across and periodM along, plus the station), whichever is higher. Heading follows the chord between
 * the points half a period either side; pitch is the bare-earth height change over that chord, applied as a rotation
 * about the base, and the y scale is divided by its cosine so the top still reaches the wanted height.
 */
function placeAlong(
  line: ReadonlyArray<Readonly<Vec2>>,
  dims: { readonly widthM: number; readonly periodM: number },
  bare: MeshSurface,
  active: MeshSurface,
  toScene: SceneMapper,
  footprints: FootprintIndex | null,
  out: Matrix4[],
): void {
  const { widthM, periodM } = dims;
  const m = measure(line);
  const length = m.cumulative[m.cumulative.length - 1] ?? 0;
  const count = Math.floor(length / periodM + 1e-9);
  const half = periodM / 2;
  const ground = (e: number, n: number): number => bare.sample(e, n).height;
  const top = (e: number, n: number): number => active.sample(e, n).height;
  for (let i = 0; i < count; i += 1) {
    const s = half + i * periodM;
    const centre = pointAt(m, s);
    const [ce, cn] = centre.p;
    if (footprints?.contains(ce, cn)) continue;
    const back = pointAt(m, s - half).p;
    const ahead = pointAt(m, s + half).p;
    let te = ahead[0] - back[0];
    let tn = ahead[1] - back[1];
    let run = Math.hypot(te, tn);
    let rise = ground(...ahead) - ground(...back);
    if (run < 1e-6) {
      // A hairpin folds the chord to a point: take the segment direction and lie flat.
      [te, tn] = centre.dir;
      run = 1;
      rise = 0;
    }
    const ue = te / run;
    const un = tn / run;
    const base = ground(ce, cn) - RIBBON_SINK_M;
    let wantTop = top(ce, cn) + DRAPE_LIFT_M + SYMBOL_HEIGHT_M;
    if (active !== bare) {
      // Right of travel is (un, -ue) in (east, north).
      let localMax = top(ce, cn);
      for (const along of [-half, 0, half]) {
        for (const across of [-widthM / 2, 0, widthM / 2]) {
          localMax = Math.max(
            localMax,
            top(ce + ue * along + un * across, cn + un * along - ue * across),
          );
        }
      }
      wantTop = Math.max(wantTop, localMax + SYMBOL_CLEAR_M);
    }
    const slope = Math.atan2(rise, run);
    const cos = Math.cos(slope);
    const pb = new Vector3(...toScene(ce, cn, base));
    const forward = new Vector3(...toScene(ce + ue * cos, cn + un * cos, base + Math.sin(slope)))
      .sub(pb)
      .normalize();
    const right = new Vector3().crossVectors(forward, UP).normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();
    const back3 = forward.clone().negate();
    // Local (0, 0, -period / 2), the centre of the symbol's base, lands on the station's base point.
    const origin = pb.clone().addScaledVector(forward, -half);
    const scaleY = (wantTop - base) / Math.max(cos, 1e-3);
    out.push(
      new Matrix4()
        .makeBasis(right, up, back3)
        .multiply(new Matrix4().makeScale(1, scaleY, 1))
        .setPosition(origin),
    );
  }
}

export interface SymbolLayerStats {
  readonly areaCount: number;
  readonly pathCount: number;
  readonly instanceCount: number;
  readonly triangleCount: number;
  readonly byTile: Readonly<Partial<Record<TileName, { areas: number; instances: number }>>>;
}

export interface SymbolLayer {
  readonly group: Group;
  /** One lit, flat-coloured material per tile (SYMBOL_COLOR). */
  readonly materials: Readonly<Record<TileName, MeshStandardMaterial>>;
  /** Every material, for patching (the horizon blend) in one loop. */
  allMaterials(): MeshStandardMaterial[];
  /** Rebuilds the per-tile instance sets for a new routing. */
  assign(assignment: RibbonAssignment): void;
  /** Routes from the annotations and the Activity filter (the same routing as the ribbons), then rebuilds. */
  applyFilter(
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void;
  /** Re-places every symbol on another active surface. No-op for the surface already active. */
  redrape(active: MeshSurface): void;
  /** Footprints under which no symbol is placed; re-places with the last active surface. */
  setFootprints(rings: readonly Ring[]): void;
  stats(): SymbolLayerStats;
  dispose(): void;
}

export interface SymbolLayerOptions {
  readonly fadeCentre: RadialFadeOptions['centre'];
}

/**
 * Builds the layer: every tile's SVG is parsed and extruded once at the tile's drawn width and period, then one
 * InstancedMesh per tile in use carries the symbols of every area routed to it. Starts routed by area kind.
 * Materials get applyRadialFade; the caller applies the horizon blend to allMaterials().
 */
export function buildSymbolLayer(
  areas: readonly Area[],
  bare: MeshSurface,
  toScene: SceneMapper,
  tiles: Readonly<Record<TileName, TileInfo>>,
  symbolSvgs: Readonly<Record<TileName, string>>,
  options: SymbolLayerOptions,
): SymbolLayer {
  const group = new Group();
  group.name = 'symbols';
  const lines = new Map<string, Vec2[][]>();
  const areaById = new Map<string, Area>();
  for (const area of areas) {
    const l = linesOf(area);
    if (l.length > 0) lines.set(area.id, l);
    areaById.set(area.id, area);
  }

  const geometries = {} as Record<TileName, BufferGeometry>;
  const materials = {} as Record<TileName, MeshStandardMaterial>;
  for (const name of TILE_NAMES) {
    let shapes: Shape[];
    try {
      shapes = parseSymbolShapes(symbolSvgs[name]);
    } catch (error) {
      throw new Error(`symbol ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    geometries[name] = buildSymbolGeometry(shapes, {
      widthM: tiles[name].widthM,
      periodM: tiles[name].periodM,
      // Unit height: each instance scales y to its own column height (see placeAlong).
      heightM: 1,
    });
    const material = new MeshStandardMaterial({
      color: SYMBOL_COLOR[name],
      roughness: 0.9,
      metalness: 0,
    });
    applyRadialFade(material, { centre: options.fadeCentre });
    materials[name] = material;
  }

  let active: MeshSurface = bare;
  let footprints: FootprintIndex | null = null;
  let meshes: Array<{ tile: TileName; mesh: InstancedMesh; areas: number }> = [];
  let areaCount = 0;
  let pathCount = 0;

  const clear = (): void => {
    for (const { mesh } of meshes) {
      group.remove(mesh);
      mesh.dispose();
    }
    meshes = [];
  };

  let lastAssignment: RibbonAssignment = new Map();
  const assign = (assignment: RibbonAssignment): void => {
    lastAssignment = assignment;
    clear();
    areaCount = 0;
    pathCount = 0;
    const byTile = new Map<TileName, { matrices: Matrix4[]; areas: number }>();
    for (const [areaId, tile] of assignment) {
      const l = lines.get(areaId);
      if (tile === null || l === undefined) continue;
      const entry = byTile.get(tile) ?? { matrices: [], areas: 0 };
      for (const line of l) {
        placeAlong(
          splitAtAllMeshEdges(active, line),
          tiles[tile],
          bare,
          active,
          toScene,
          footprints,
          entry.matrices,
        );
      }
      entry.areas += 1;
      byTile.set(tile, entry);
      areaCount += 1;
      pathCount += l.length;
    }
    for (const name of TILE_NAMES) {
      const entry = byTile.get(name);
      if (entry === undefined || entry.matrices.length === 0) continue;
      const mesh = new InstancedMesh(geometries[name], materials[name], entry.matrices.length);
      entry.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
      mesh.name = `symbols-${name}`;
      // Picking stays on the Line2 area lines; a symbol never intercepts a ray.
      mesh.raycast = () => {};
      group.add(mesh);
      meshes.push({ tile: name, mesh, areas: entry.areas });
    }
  };

  assign(assignTiles(areas, new Map(), new Set(), null));

  return {
    group,
    materials,
    allMaterials: () => Object.values(materials),
    assign,
    applyFilter(annotations, selected, visibleIds) {
      assign(assignTiles(areaById.values(), annotations, selected, visibleIds));
    },
    redrape(next) {
      if (next === active) return;
      active = next;
      assign(lastAssignment);
    },
    setFootprints(rings) {
      footprints = new FootprintIndex(rings);
      assign(lastAssignment);
    },
    stats() {
      const byTile: Partial<Record<TileName, { areas: number; instances: number }>> = {};
      let instanceCount = 0;
      let triangleCount = 0;
      for (const { tile, mesh, areas: n } of meshes) {
        byTile[tile] = { areas: n, instances: mesh.count };
        instanceCount += mesh.count;
        const index = mesh.geometry.getIndex();
        const perInstance =
          (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
        triangleCount += perInstance * mesh.count;
      }
      return { areaCount, pathCount, instanceCount, triangleCount, byTile };
    },
    dispose() {
      clear();
      (group.parent as Object3D | null)?.remove(group);
      for (const name of TILE_NAMES) {
        materials[name].dispose();
        geometries[name].dispose();
      }
    },
  };
}

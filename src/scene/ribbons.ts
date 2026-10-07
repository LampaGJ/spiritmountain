/**
 * Trail ribbons: each non-lift area becomes a closed volume (a flat-coloured top strip, side walls, a base and end caps)
 * that stands on the ground and rises through the canopy, so a trail stays readable over every layer.
 *
 * Geometry (buildRibbonGeometry) is pure three (no renderer, no DOM) so it tests in node. The layer (buildRibbonLayer)
 * owns one Mesh per tile in use, rebuilt on a filter change and re-draped when the active heightfield changes.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
} from 'three';
import type { Area } from '../schema/area';
import type { Annotation } from '../schema/annotation';
import type { Activity } from '../ui/filter-predicate';
import { DRAPE_LIFT_M, densify, splitAtAllMeshEdges, type Vec2 } from './drape';
import { applyRadialFade, type RadialFadeOptions } from './fade';
import type { MeshSurface } from './heightfield';
import type { SceneMapper } from './areas';
import {
  RIBBON_TOP_COLOR,
  TILE_EDGE_COLOR,
  TILE_NAMES,
  tileForArea,
  type TileInfo,
  type TileName,
} from './ribbon-kinds';

/** The base of a ribbon sits this far below bare earth, so no gap shows between ribbon and ground. */
export const RIBBON_SINK_M = 0.3;
/** Wall height in the open: 0.5 m of lift above the ground plus 0.3 m sunk below it. */
export const RIBBON_OPEN_WALL_M = DRAPE_LIFT_M + RIBBON_SINK_M;
/** Horizontal spacing of ribbon stations along the centre line, in metres. */
export const RIBBON_STEP_M = 3;
/** Widest span between top-strip columns across the ribbon, so a wide run follows ground that curves across it. */
export const RIBBON_LATERAL_STEP_M = 3;
/** A mitred corner is never stretched past this multiple of the half width, so a hairpin cannot spike. */
export const MITER_LIMIT = 2.5;
/** The side walls are the tile's edge colour times this (a 35 percent darkening). */
export const WALL_DARKEN = 0.65;
/** The wall's base colour is the top colour times this, the subtle vertical gradient. */
export const WALL_BASE_SHADE = 0.7;

type Ring = ReadonlyArray<ReadonlyArray<number>>;

/**
 * Point-in-footprint lookup over building outer rings, bucketed on a 64 m grid.
 * A ribbon station inside any footprint drapes on bare earth, so a ribbon never climbs a roof the LiDAR surface contains.
 */
export class FootprintIndex {
  private static readonly CELL_M = 64;
  private readonly rings: Ring[];
  private readonly boxes: Array<[number, number, number, number]> = [];
  private readonly cells = new Map<string, number[]>();

  constructor(rings: readonly Ring[]) {
    this.rings = [...rings];
    this.rings.forEach((ring, id) => {
      let [minE, minN, maxE, maxN] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of ring) {
        minE = Math.min(minE, p[0] as number);
        maxE = Math.max(maxE, p[0] as number);
        minN = Math.min(minN, p[1] as number);
        maxN = Math.max(maxN, p[1] as number);
      }
      this.boxes.push([minE, minN, maxE, maxN]);
      const c = FootprintIndex.CELL_M;
      for (let ce = Math.floor(minE / c); ce <= Math.floor(maxE / c); ce += 1) {
        for (let cn = Math.floor(minN / c); cn <= Math.floor(maxN / c); cn += 1) {
          const key = `${ce},${cn}`;
          const list = this.cells.get(key);
          if (list) list.push(id);
          else this.cells.set(key, [id]);
        }
      }
    });
  }

  get size(): number {
    return this.rings.length;
  }

  contains(east: number, north: number): boolean {
    const c = FootprintIndex.CELL_M;
    const candidates = this.cells.get(`${Math.floor(east / c)},${Math.floor(north / c)}`);
    if (!candidates) return false;
    for (const id of candidates) {
      const [minE, minN, maxE, maxN] = this.boxes[id] as [number, number, number, number];
      if (east < minE || east > maxE || north < minN || north > maxN) continue;
      if (pointInRing(east, north, this.rings[id] as Ring)) return true;
    }
    return false;
  }
}

/** Even-odd ray cast. The ring may be open or closed. */
function pointInRing(east: number, north: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [ei, ni] = [(ring[i] as number[])[0] as number, (ring[i] as number[])[1] as number];
    const [ej, nj] = [(ring[j] as number[])[0] as number, (ring[j] as number[])[1] as number];
    if (ni > north !== nj > north && east < ((ej - ei) * (north - ni)) / (nj - ni) + ei) {
      inside = !inside;
    }
  }
  return inside;
}

export interface RibbonPathInput {
  readonly areaId: string;
  /** Centre line, local metres (east, north). */
  readonly line: ReadonlyArray<Readonly<Vec2>>;
}

export interface RibbonSpec {
  /** Ribbon width in metres. */
  readonly widthM: number;
  /** Metres of trail per tile repeat: u = cumulative length / periodM (the symbols are spaced at the same period). */
  readonly periodM: number;
  /** Station spacing along the line; defaults to RIBBON_STEP_M. */
  readonly stepM?: number;
  /** Wall base colour (sRGB, any three colour string). */
  readonly edgeColor: string;
}

/** Where one path's vertices sit in the geometry, so callers and tests can address them without re-deriving the layout. */
export interface RibbonRange {
  readonly areaId: string;
  readonly stations: number;
  /** Top-strip columns across: column 0 is the left edge (looking along the line), the last is the right edge. */
  readonly columns: number;
  /** First top vertex; vertex (station i, column j) is top + i * columns + j. */
  readonly top: number;
  /** Left wall: wallLeft + 2 i is the top edge vertex, + 1 the base vertex. */
  readonly wallLeft: number;
  readonly wallRight: number;
  /** Bottom face: bottom + 2 i is the left base vertex, + 1 the right. */
  readonly bottom: number;
  /** End caps, columns + 2 vertices each: the top edge columns left to right (so the cap meets every top-strip vertex), then the left base and right base. */
  readonly capStart: number;
  readonly capEnd: number;
}

export interface RibbonBuild {
  readonly geometry: BufferGeometry;
  readonly ranges: readonly RibbonRange[];
  readonly triangleCount: number;
  /**
   * Rewrites the top strip from `active` (the surface that is drawn) plus the 0.5 m lift, and keeps the base on bare
   * earth minus 0.3 m. A station inside a footprint drapes its top on bare earth instead. Positions are rewritten in
   * place, normals and bounds recomputed.
   */
  redrape(active: MeshSurface, footprints: FootprintIndex | null): void;
}

interface PathData {
  readonly range: RibbonRange;
  /** Per station, per column: east, north. */
  readonly columnXY: Float64Array;
  /** Per station: base elevation of the left and right edge (bare earth minus the sink). */
  readonly baseElev: Float64Array;
}

/** Station positions, miter offsets and cumulative lengths for one centre line. */
function layOutStations(
  line: ReadonlyArray<Readonly<Vec2>>,
  halfWidth: number,
  stepM: number,
): { xy: Vec2[]; offsets: Vec2[]; cumulative: number[] } {
  const xy = densify(line, stepM);
  const n = xy.length;
  const normals: Vec2[] = [];
  const cumulative: number[] = [0];
  for (let k = 0; k + 1 < n; k += 1) {
    const a = xy[k] as Vec2;
    const b = xy[k + 1] as Vec2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    normals.push([-(b[1] - a[1]) / len, (b[0] - a[0]) / len]);
    cumulative.push((cumulative[k] as number) + len);
  }
  const offsets: Vec2[] = [];
  for (let i = 0; i < n; i += 1) {
    const before = normals[i - 1];
    const after = normals[i];
    if (before === undefined) {
      const m = after as Vec2;
      offsets.push([m[0] * halfWidth, m[1] * halfWidth]);
    } else if (after === undefined) {
      offsets.push([before[0] * halfWidth, before[1] * halfWidth]);
    } else {
      const sx = before[0] + after[0];
      const sy = before[1] + after[1];
      const sl = Math.hypot(sx, sy);
      if (sl < 1e-9) {
        offsets.push([after[0] * halfWidth, after[1] * halfWidth]);
      } else {
        const mx = sx / sl;
        const my = sy / sl;
        const cosHalf = mx * after[0] + my * after[1];
        const scale = Math.min(1 / Math.max(cosHalf, 1e-6), MITER_LIMIT) * halfWidth;
        offsets.push([mx * scale, my * scale]);
      }
    }
  }
  return { xy, offsets, cumulative };
}

/**
 * Builds ONE BufferGeometry holding the closed volumes of every path, in two index groups: group 0 is the flat
 * top strip (material 0), group 1 the side walls, bottom and end caps (material 1, vertex-coloured).
 *
 * Vertex layout per path (N stations, C columns): N*C top, 2N left wall, 2N right wall, 2N bottom, then two end caps of C + 2.
 * The top strip and the walls share positions but not vertices, so each keeps its own uv, colour and normal;
 * watertightness holds on welded positions. u = cumulative length / periodM, v = column / (C - 1).
 */
export function buildRibbonGeometry(
  paths: readonly RibbonPathInput[],
  spec: RibbonSpec,
  bare: MeshSurface,
  toScene: SceneMapper,
): RibbonBuild {
  const half = spec.widthM / 2;
  const stepM = spec.stepM ?? RIBBON_STEP_M;
  const segments = Math.max(1, Math.ceil(spec.widthM / RIBBON_LATERAL_STEP_M - 1e-9));
  const columns = segments + 1;
  const wallTop = new Color(spec.edgeColor).multiplyScalar(WALL_DARKEN);
  const wallBase = wallTop.clone().multiplyScalar(WALL_BASE_SHADE);

  const data: PathData[] = [];
  const laid = paths
    .map((path) => ({ path, ...layOutStations(path.line, half, stepM) }))
    .filter((p) => p.xy.length >= 2);
  let vertexCount = 0;
  for (const { path, xy } of laid) {
    const n = xy.length;
    const range: RibbonRange = {
      areaId: path.areaId,
      stations: n,
      columns,
      top: vertexCount,
      wallLeft: vertexCount + n * columns,
      wallRight: vertexCount + n * columns + 2 * n,
      bottom: vertexCount + n * columns + 4 * n,
      capStart: vertexCount + n * columns + 6 * n,
      capEnd: vertexCount + n * columns + 6 * n + columns + 2,
    };
    vertexCount += n * columns + 6 * n + 2 * (columns + 2);
    data.push({
      range,
      columnXY: new Float64Array(n * columns * 2),
      baseElev: new Float64Array(2 * n),
    });
  }

  const position = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const color = new Float32Array(vertexCount * 3).fill(1);
  const topIndex: number[] = [];
  const restIndex: number[] = [];
  const setColor = (v: number, c: Color): void => {
    color[v * 3] = c.r;
    color[v * 3 + 1] = c.g;
    color[v * 3 + 2] = c.b;
  };

  laid.forEach(({ xy, offsets, cumulative }, pathIndex) => {
    const { range, columnXY, baseElev } = data[pathIndex] as PathData;
    const n = range.stations;
    for (let i = 0; i < n; i += 1) {
      const [e, nn] = xy[i] as Vec2;
      const [ox, oy] = offsets[i] as Vec2;
      const u = (cumulative[i] as number) / spec.periodM;
      for (let j = 0; j < columns; j += 1) {
        const f = 1 - (2 * j) / segments; // +1 left edge ... -1 right edge
        columnXY[(i * columns + j) * 2] = e + f * ox;
        columnXY[(i * columns + j) * 2 + 1] = nn + f * oy;
        const v = range.top + i * columns + j;
        uv[v * 2] = u;
        uv[v * 2 + 1] = j / segments;
      }
      const left = i * columns;
      const right = i * columns + segments;
      baseElev[2 * i] =
        bare.sample(columnXY[left * 2] as number, columnXY[left * 2 + 1] as number).height -
        RIBBON_SINK_M;
      baseElev[2 * i + 1] =
        bare.sample(columnXY[right * 2] as number, columnXY[right * 2 + 1] as number).height -
        RIBBON_SINK_M;
      for (const v of [range.wallLeft + 2 * i, range.wallRight + 2 * i]) setColor(v, wallTop);
      for (const v of [range.wallLeft + 2 * i + 1, range.wallRight + 2 * i + 1])
        setColor(v, wallBase);
      setColor(range.bottom + 2 * i, wallBase);
      setColor(range.bottom + 2 * i + 1, wallBase);
    }
    for (const cap of [range.capStart, range.capEnd]) {
      for (let j = 0; j < columns; j += 1) setColor(cap + j, wallTop);
      setColor(cap + columns, wallBase);
      setColor(cap + columns + 1, wallBase);
    }

    for (let i = 0; i + 1 < n; i += 1) {
      for (let j = 0; j < segments; j += 1) {
        const a = range.top + i * columns + j;
        const b = a + 1;
        const c = a + columns;
        const d = c + 1;
        topIndex.push(a, b, c, b, d, c);
      }
      const lt = range.wallLeft + 2 * i;
      const lt1 = lt + 2;
      restIndex.push(lt, lt1, lt + 1, lt + 1, lt1, lt1 + 1);
      const rt = range.wallRight + 2 * i;
      const rt1 = rt + 2;
      restIndex.push(rt, rt + 1, rt1, rt + 1, rt1 + 1, rt1);
      const bl = range.bottom + 2 * i;
      const bl1 = bl + 2;
      restIndex.push(bl, bl1, bl + 1, bl + 1, bl1, bl1 + 1);
    }
    // Start cap faces backward: a fan from the left base over the top edge. The end cap is the same fan reversed.
    for (const [cap, forward] of [
      [range.capStart, true],
      [range.capEnd, false],
    ] as const) {
      const bl = cap + columns;
      const br = bl + 1;
      const tri = (a: number, b: number, c: number): void => {
        if (forward) restIndex.push(a, b, c);
        else restIndex.push(a, c, b);
      };
      tri(bl, br, cap + segments);
      for (let j = segments; j >= 1; j -= 1) tri(bl, cap + j, cap + j - 1);
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setAttribute('color', new BufferAttribute(color, 3));
  geometry.setIndex(new BufferAttribute(Uint32Array.from([...topIndex, ...restIndex]), 1));
  geometry.addGroup(0, topIndex.length, 0);
  geometry.addGroup(topIndex.length, restIndex.length, 1);

  const put = (v: number, east: number, north: number, elevation: number): void => {
    const p = toScene(east, north, elevation);
    position[v * 3] = p[0];
    position[v * 3 + 1] = p[1];
    position[v * 3 + 2] = p[2];
  };

  const redrape = (active: MeshSurface, footprints: FootprintIndex | null): void => {
    for (const { range, columnXY, baseElev } of data) {
      const n = range.stations;
      for (let i = 0; i < n; i += 1) {
        let onFootprint = false;
        if (footprints) {
          for (let j = 0; j < columns && !onFootprint; j += 1) {
            onFootprint = footprints.contains(
              columnXY[(i * columns + j) * 2] as number,
              columnXY[(i * columns + j) * 2 + 1] as number,
            );
          }
        }
        const surface = onFootprint ? bare : active;
        for (let j = 0; j < columns; j += 1) {
          const e = columnXY[(i * columns + j) * 2] as number;
          const nn = columnXY[(i * columns + j) * 2 + 1] as number;
          put(range.top + i * columns + j, e, nn, surface.sample(e, nn).height + DRAPE_LIFT_M);
        }
        const l = i * columns;
        const r = i * columns + segments;
        const [le, ln] = [columnXY[l * 2] as number, columnXY[l * 2 + 1] as number];
        const [re, rn] = [columnXY[r * 2] as number, columnXY[r * 2 + 1] as number];
        const topL = range.top + l;
        const topR = range.top + r;
        const copy = (to: number, from: number): void => {
          position[to * 3] = position[from * 3] as number;
          position[to * 3 + 1] = position[from * 3 + 1] as number;
          position[to * 3 + 2] = position[from * 3 + 2] as number;
        };
        copy(range.wallLeft + 2 * i, topL);
        copy(range.wallRight + 2 * i, topR);
        put(range.wallLeft + 2 * i + 1, le, ln, baseElev[2 * i] as number);
        put(range.wallRight + 2 * i + 1, re, rn, baseElev[2 * i + 1] as number);
        copy(range.bottom + 2 * i, range.wallLeft + 2 * i + 1);
        copy(range.bottom + 2 * i + 1, range.wallRight + 2 * i + 1);
        if (i === 0 || i === n - 1) {
          const cap = i === 0 ? range.capStart : range.capEnd;
          for (let j = 0; j < columns; j += 1) copy(cap + j, range.top + i * columns + j);
          copy(cap + columns, range.wallLeft + 2 * i + 1);
          copy(cap + columns + 1, range.wallRight + 2 * i + 1);
        }
      }
    }
    geometry.getAttribute('position').needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  };
  redrape(bare, null);

  return {
    geometry,
    ranges: data.map((d) => d.range),
    triangleCount: (topIndex.length + restIndex.length) / 3,
    redrape,
  };
}

/** The tile each area shows right now, null for no ribbon (lifts, or an area the filter hides). */
export type RibbonAssignment = ReadonlyMap<string, TileName | null>;

/**
 * Routes every area to a tile for one filter state. `visibleIds` null means every area is visible.
 * Pure: the same inputs always give the same assignment.
 */
export function assignTiles(
  areas: Iterable<Area>,
  annotations: ReadonlyMap<string, Annotation>,
  selected: ReadonlySet<Activity>,
  visibleIds: ReadonlySet<string> | null,
): Map<string, TileName | null> {
  const out = new Map<string, TileName | null>();
  for (const area of areas) {
    const visible = visibleIds === null || visibleIds.has(area.id);
    out.set(area.id, visible ? tileForArea(area, annotations.get(area.id), selected) : null);
  }
  return out;
}

export interface RibbonLayerStats {
  readonly areaCount: number;
  readonly pathCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly byTile: Readonly<Partial<Record<TileName, { areas: number; triangles: number }>>>;
}

export interface RibbonLayer {
  readonly group: Group;
  /** One unlit MeshBasicMaterial per tile (the top): a flat map colour (RIBBON_TOP_COLOR) the extruded symbols stand on. */
  readonly topMaterials: Readonly<Record<TileName, MeshBasicMaterial>>;
  /** The one vertex-coloured material every ribbon's walls, base and caps share. */
  readonly wallMaterial: MeshStandardMaterial;
  /** Every material, for patching (the horizon blend) in one loop. */
  allMaterials(): (MeshBasicMaterial | MeshStandardMaterial)[];
  /** Rebuilds the per-tile geometries for a new routing. */
  assign(assignment: RibbonAssignment): void;
  /** Routes from the annotations and the Activity filter, then rebuilds. */
  applyFilter(
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void;
  /**
   * Re-lays every ribbon on another active surface (the composite, or the bare-earth surface to restore): stations are
   * split at that surface's mesh edges, so this rebuilds the geometries. No-op for the surface already active.
   */
  redrape(active: MeshSurface): void;
  /** Footprints that keep ribbons off roofs; re-drapes with the last active surface. */
  setFootprints(rings: readonly Ring[]): void;
  stats(): RibbonLayerStats;
  dispose(): void;
}

export interface RibbonLayerOptions {
  readonly fadeCentre: RadialFadeOptions['centre'];
  readonly stepM?: number;
}

/** The centre lines of a non-lift area: the LineString, or every ring of a Polygon. */
export function linesOf(area: Area): Vec2[][] {
  if (area.kind === 'lift') return [];
  const raw =
    area.geometry.type === 'LineString' ? [area.geometry.coordinates] : area.geometry.coordinates;
  return raw.map((line) => line.map((p): Vec2 => [p[0] as number, p[1] as number]));
}

/**
 * Builds the layer. Each tile's top is a flat unlit colour; the symbols that mark the activity are a separate layer
 * (symbols.ts). Starts routed by area kind (no annotations, no filter).
 * Materials get applyRadialFade; the caller applies the horizon blend to allMaterials().
 */
export function buildRibbonLayer(
  areas: readonly Area[],
  bare: MeshSurface,
  toScene: SceneMapper,
  tiles: Readonly<Record<TileName, TileInfo>>,
  options: RibbonLayerOptions,
): RibbonLayer {
  const group = new Group();
  group.name = 'ribbons';
  const lines = new Map<string, Vec2[][]>();
  const areaById = new Map<string, Area>();
  for (const area of areas) {
    const l = linesOf(area);
    if (l.length > 0) lines.set(area.id, l);
    areaById.set(area.id, area);
  }

  const topMaterials = {} as Record<TileName, MeshBasicMaterial>;
  for (const name of TILE_NAMES) {
    // Unlit (#37): the top is a map colour. Under the photo sky's dimmed sun and quarter hemisphere a lit white top
    // rendered mid grey, so every snow trail read as a grey strip.
    const material = new MeshBasicMaterial({ color: RIBBON_TOP_COLOR[name] });
    // No polygonOffset: at a grazing view its slope term pushes a far ribbon behind the terrain it stands on.
    // The area line, level with the ribbon top, is pulled forward instead (see buildAreaLayer).
    applyRadialFade(material, { centre: options.fadeCentre });
    topMaterials[name] = material;
  }
  const wallMaterial = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  applyRadialFade(wallMaterial, { centre: options.fadeCentre });

  let active: MeshSurface = bare;
  let footprints: FootprintIndex | null = null;
  let builds: Array<{ tile: TileName; mesh: Mesh; build: RibbonBuild; areas: number }> = [];
  let areaCount = 0;
  let pathCount = 0;

  const clear = (): void => {
    for (const { mesh } of builds) {
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    builds = [];
  };

  let lastAssignment: RibbonAssignment = new Map();
  const assign = (assignment: RibbonAssignment): void => {
    lastAssignment = assignment;
    clear();
    areaCount = 0;
    pathCount = 0;
    const byTile = new Map<TileName, { paths: RibbonPathInput[]; areas: number }>();
    for (const [areaId, tile] of assignment) {
      const l = lines.get(areaId);
      if (tile === null || l === undefined) continue;
      const entry = byTile.get(tile) ?? { paths: [], areas: 0 };
      // Stations must sit on the drawn surface's own triangles (#36): a 3 m station step over a 2 m LiDAR canopy mesh
      // left the top strip under the crowns between stations. Split each centre line at the active surface's mesh
      // edges before the step densify, so a surface change re-lays the stations (see redrape).
      for (const line of l) entry.paths.push({ areaId, line: splitAtAllMeshEdges(active, line) });
      entry.areas += 1;
      byTile.set(tile, entry);
      areaCount += 1;
      pathCount += l.length;
    }
    for (const name of TILE_NAMES) {
      const entry = byTile.get(name);
      if (entry === undefined) continue;
      const info = tiles[name];
      const build = buildRibbonGeometry(
        entry.paths,
        {
          widthM: info.widthM,
          periodM: info.periodM,
          edgeColor: TILE_EDGE_COLOR[name],
          ...(options.stepM !== undefined ? { stepM: options.stepM } : {}),
        },
        bare,
        toScene,
      );
      build.redrape(active, footprints);
      const mesh = new Mesh(build.geometry, [topMaterials[name], wallMaterial]);
      mesh.name = `ribbons-${name}`;
      // Picking stays on the Line2 area lines; a ribbon never intercepts a ray.
      mesh.raycast = () => {};
      group.add(mesh);
      builds.push({ tile: name, mesh, build, areas: entry.areas });
    }
  };

  const defaults = assignTiles(areas, new Map(), new Set(), null);
  assign(defaults);

  return {
    group,
    topMaterials,
    wallMaterial,
    allMaterials: () => [...Object.values(topMaterials), wallMaterial],
    assign,
    applyFilter(annotations, selected, visibleIds) {
      assign(assignTiles(areaById.values(), annotations, selected, visibleIds));
    },
    redrape(next) {
      if (next === active) return;
      // The station layout depends on the surface's mesh edges, so a new surface rebuilds rather than re-samples.
      active = next;
      assign(lastAssignment);
    },
    setFootprints(rings) {
      footprints = new FootprintIndex(rings);
      for (const { build } of builds) build.redrape(active, footprints);
    },
    stats() {
      const byTile: Partial<Record<TileName, { areas: number; triangles: number }>> = {};
      let vertexCount = 0;
      let triangleCount = 0;
      for (const { tile, build, areas: n } of builds) {
        byTile[tile] = { areas: n, triangles: build.triangleCount };
        vertexCount += build.geometry.getAttribute('position').count;
        triangleCount += build.triangleCount;
      }
      return { areaCount, pathCount, vertexCount, triangleCount, byTile };
    },
    dispose() {
      clear();
      (group.parent as Object3D | null)?.remove(group);
      for (const material of [...Object.values(topMaterials), wallMaterial]) material.dispose();
    },
  };
}

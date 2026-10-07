// @vitest-environment jsdom
import { InstancedMesh, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Area } from '../../src/schema/area';
import { DRAPE_LIFT_M, type Vec2 } from '../../src/scene/drape';
import { createMeshSurface, type MeshSurface } from '../../src/scene/heightfield';
import { TILE_NAMES, TILES, type TileName } from '../../src/scene/ribbon-kinds';
import { SYMBOL_SOURCES } from '../../src/scene/symbol-sources';
import { RIBBON_SINK_M } from '../../src/scene/ribbons';
import { surfaceSampler } from '../../src/scene/surface';
import {
  SYMBOL_CLEAR_M,
  SYMBOL_HEIGHT_M,
  buildSymbolGeometry,
  buildSymbolLayer,
  parseSymbolShapes,
} from '../../src/scene/symbols';

const RECT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100"/></svg>';
const HALF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="50" height="25"/></svg>';
const RING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z"/></svg>';
const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';

/** A 1 m grid over east -200..200, north -200..200 whose height is fn(east, north). */
function surfaceOf(fn: (east: number, north: number) => number): MeshSurface {
  const cols = 401;
  const rows = 401;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = fn(-200 + c, 200 - r);
  }
  return createMeshSurface(
    { cols, rows, originEast: -200, originNorth: 200, cellSizeEast: 1, cellSizeNorth: 1, data },
    400,
  );
}

const FLAT = surfaceOf(() => 0);
const toScene = (e: number, n: number, z: number): [number, number, number] => [e, z, -n];
const area = (id: string, line: Vec2[]): Area => ({
  id,
  kind: 'mtb-trail',
  name: null,
  difficulty: null,
  osmTags: {},
  geometry: { type: 'LineString', coordinates: line.map(([e, n]) => [e, n, 0]) },
});
const RECTS = Object.fromEntries(TILE_NAMES.map((n) => [n, RECT_SVG])) as Record<TileName, string>;
const EAST = area('way/1', [
  [0, 0],
  [100, 0],
]);
const NORTH = area('way/2', [
  [0, 0],
  [0, 100],
]);
const P = TILES['mtb-trail'].periodM;

const layerOf = (areas: Area[], bare: MeshSurface = FLAT) =>
  buildSymbolLayer(areas, bare, toScene, TILES, RECTS, { fadeCentre: { east: 0, north: 0 } });

function meshOf(layer: ReturnType<typeof layerOf>, tile: TileName = 'mtb-trail'): InstancedMesh {
  const mesh = layer.group.children.find((c) => c.name === `symbols-${tile}`);
  if (!(mesh instanceof InstancedMesh)) throw new Error(`no symbols-${tile}`);
  return mesh;
}
function matrixAt(mesh: InstancedMesh, i: number): Matrix4 {
  const m = new Matrix4();
  mesh.getMatrixAt(i, m);
  return m;
}
/** The scene point the centre of the symbol's base (local 0, 0, -period / 2) lands on. */
const centreOf = (m: Matrix4): Vector3 => new Vector3(0, 0, -P / 2).applyMatrix4(m);
/** Length of the instance's local y axis: the column height (the geometry has unit height). */
const scaleYOf = (m: Matrix4): number => new Vector3().setFromMatrixColumn(m, 1).length();
/** The scene point the centre of the symbol's top lands on. */
const topOf = (m: Matrix4): Vector3 => new Vector3(0, 1, -P / 2).applyMatrix4(m);
/** Column height on bare ground: the slab depth plus the ribbon lift plus SYMBOL_HEIGHT_M. */
const MIN_SCALE = RIBBON_SINK_M + DRAPE_LIFT_M + SYMBOL_HEIGHT_M;
/** Where local -z (the direction of travel) points in the scene. */
const travelOf = (m: Matrix4): Vector3 => new Vector3(0, 0, -1).transformDirection(m);

describe('parseSymbolShapes', () => {
  it('a rect is one shape with no holes', () => {
    const shapes = parseSymbolShapes(RECT_SVG);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.holes).toHaveLength(0);
  });
  it('an evenodd ring is one shape with one hole', () => {
    const shapes = parseSymbolShapes(RING_SVG);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.holes).toHaveLength(1);
  });
  it('an SVG with no filled shape is an error, never an empty list', () => {
    expect(() => parseSymbolShapes(EMPTY_SVG)).toThrow(/no shape/);
  });
  it('every committed symbol SVG parses to at least one shape', () => {
    for (const name of TILE_NAMES) {
      expect(parseSymbolShapes(SYMBOL_SOURCES[name]).length, name).toBeGreaterThan(0);
    }
  });
});

describe('buildSymbolGeometry', () => {
  const dims = { widthM: 20, periodM: 12, heightM: 0.6 };
  it('maps the full viewBox to width across (centred), one period along -z, height up +y', () => {
    const g = buildSymbolGeometry(parseSymbolShapes(RECT_SVG), dims);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.min.x).toBeCloseTo(-10, 5);
    expect(b.max.x).toBeCloseTo(10, 5);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(0.6, 5);
    expect(b.min.z).toBeCloseTo(-12, 5);
    expect(b.max.z).toBeCloseTo(0, 5);
  });
  it('svg x 0..50 is the left half, svg y 0..25 the first quarter period', () => {
    const g = buildSymbolGeometry(parseSymbolShapes(HALF_SVG), dims);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.min.x).toBeCloseTo(-10, 5);
    expect(b.max.x).toBeCloseTo(0, 5);
    expect(b.min.z).toBeCloseTo(-3, 5);
    expect(b.max.z).toBeCloseTo(0, 5);
  });
});

describe('buildSymbolLayer', () => {
  it('places floor(length / period) instances, the first centred period / 2 along', () => {
    const layer = layerOf([EAST]);
    const mesh = meshOf(layer);
    expect(mesh.count).toBe(Math.floor(100 / P));
    expect(layer.stats().instanceCount).toBe(Math.floor(100 / P));
    const c = centreOf(matrixAt(mesh, 0));
    expect(c.x).toBeCloseTo(P / 2, 4);
    expect(c.y).toBeCloseTo(-RIBBON_SINK_M, 4);
    expect(c.z).toBeCloseTo(0, 4);
    const c1 = centreOf(matrixAt(mesh, 1));
    expect(c1.x).toBeCloseTo(P / 2 + P, 4);
  });

  it('turns local -z to the direction of travel: east is scene +x, north is scene -z', () => {
    const east = matrixAt(meshOf(layerOf([EAST])), 0);
    const te = travelOf(east);
    expect(te.x).toBeCloseTo(1, 5);
    expect(te.z).toBeCloseTo(0, 5);
    // Right of travel (local +x) heading east is south, scene +z.
    expect(new Vector3(1, 0, 0).transformDirection(east).z).toBeCloseTo(1, 5);
    const north = matrixAt(meshOf(layerOf([NORTH])), 0);
    const tn = travelOf(north);
    expect(tn.x).toBeCloseTo(0, 5);
    expect(tn.z).toBeCloseTo(-1, 5);
    expect(new Vector3(1, 0, 0).transformDirection(north).x).toBeCloseTo(1, 5);
    // The extrusion stays upright on flat ground.
    expect(new Vector3(0, 1, 0).transformDirection(north).y).toBeCloseTo(1, 5);
  });

  it('tilts with the slope on a ramp', () => {
    const ramp = surfaceOf((e) => 0.2 * e);
    const m = matrixAt(meshOf(layerOf([EAST], ramp)), 0);
    expect(travelOf(m).y).toBeCloseTo(0.2 / Math.hypot(1, 0.2), 4);
    expect(centreOf(m).y).toBeCloseTo(0.2 * (P / 2) - RIBBON_SINK_M, 3);
    // Rotated about the base, the column top still reaches SYMBOL_HEIGHT_M above the ribbon top.
    expect(topOf(m).y).toBeCloseTo(0.2 * (P / 2) + DRAPE_LIFT_M + SYMBOL_HEIGHT_M, 3);
  });

  it('re-places instances on redrape: the column grows to clear a raised surface and shrinks back', () => {
    const layer = layerOf([EAST]);
    layer.redrape(surfaceOf(() => 50));
    expect(topOf(matrixAt(meshOf(layer), 0)).y).toBeCloseTo(50 + SYMBOL_CLEAR_M, 4);
    layer.redrape(FLAT);
    expect(scaleYOf(matrixAt(meshOf(layer), 0))).toBeCloseTo(MIN_SCALE, 4);
  });

  it('on bare ground the column is the minimum: slab depth, ribbon lift and SYMBOL_HEIGHT_M', () => {
    const mesh = meshOf(layerOf([EAST]));
    for (let i = 0; i < mesh.count; i += 1)
      expect(scaleYOf(matrixAt(mesh, i))).toBeCloseTo(MIN_SCALE, 4);
  });

  it('under a 12 m canopy the column rises from bare earth to SYMBOL_CLEAR_M above the crown', () => {
    // A 2 m core over east 10..26, north -12..12, 12 m above flat bare earth once the core lift is added.
    const cols = 9;
    const rows = 13;
    const coreLift = 2 * 0.3;
    const core = createMeshSurface(
      {
        cols,
        rows,
        originEast: 10,
        originNorth: 12,
        cellSizeEast: 2,
        cellSizeNorth: 2,
        data: new Float32Array(cols * rows).fill(12 - coreLift),
      },
      Number.MAX_SAFE_INTEGER,
    );
    const composite = surfaceSampler({ core, fallback: FLAT });
    const canopy = composite.sample(18, 0).height;
    expect(canopy).toBeCloseTo(12, 5);
    const layer = layerOf([EAST]);
    layer.redrape(composite);
    const mesh = meshOf(layer);
    // Station 1 (18 m along) stands under the canopy.
    const under = matrixAt(mesh, 1);
    expect(scaleYOf(under)).toBeCloseTo(12 + RIBBON_SINK_M + SYMBOL_CLEAR_M, 4);
    expect(topOf(under).y).toBeGreaterThan(canopy);
    expect(centreOf(under).y).toBeCloseTo(-RIBBON_SINK_M, 4);
    // Station 5 (66 m along) is in the open: the minimum, plus the clearance over open ground.
    expect(scaleYOf(matrixAt(mesh, 5))).toBeCloseTo(RIBBON_SINK_M + SYMBOL_CLEAR_M, 4);
  });

  it('skips stations over a building footprint', () => {
    const layer = layerOf([EAST]);
    layer.setFootprints([
      [
        [40, -10],
        [60, -10],
        [60, 10],
        [40, 10],
        [40, -10],
      ],
    ]);
    // Centres at 6, 18, 30, 42, 54, 66, 78, 90: 42 and 54 sit on the footprint.
    expect(meshOf(layer).count).toBe(Math.floor(100 / P) - 2);
  });

  it('rebuilds on assign, and dropping every area empties the group', () => {
    const layer = layerOf([EAST, NORTH]);
    expect(layer.stats().instanceCount).toBe(2 * Math.floor(100 / P));
    layer.assign(new Map([['way/1', 'tubing' as TileName]]));
    expect(layer.group.children.map((c) => c.name)).toEqual(['symbols-tubing']);
    layer.assign(new Map());
    expect(layer.group.children).toHaveLength(0);
    expect(layer.stats().instanceCount).toBe(0);
  });

  it('builds one material per tile and unit-height geometry, scaled per instance', () => {
    const layer = layerOf([EAST]);
    expect(layer.allMaterials()).toHaveLength(TILE_NAMES.length);
    const g = meshOf(layer).geometry;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y - g.boundingBox!.min.y).toBeCloseTo(1, 5);
  });
});

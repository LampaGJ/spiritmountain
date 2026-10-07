import { describe, expect, it } from 'vitest';
import {
  BARE_EARTH_CELL_M,
  DATA_EAST_EDGE_LOCAL_M,
  EPT_EXTENT_3857,
  FOCUS_BOX,
  EPT_URL,
  EPT_URL_EAST,
  SQUARE_TEMPLATE_FILE,
  assertInsideEptExtent,
  computeSquareWindow,
  planFor,
  computeSurfaceWindow,
  fromEpt3857,
  parsePointCounts,
  resolvePipeline,
  toEpt3857,
} from '../../scripts/ingest/surface';
import { SurfaceManifestSchema } from '../../scripts/ingest/surface-manifest-schema';
import template from '../../scripts/ingest/surface-pipeline.json';
import { ORIGIN } from '../../scripts/ingest/local-frame';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { readFileSync } from 'node:fs';

describe('surface window', () => {
  const w = computeSurfaceWindow();

  it('is a 2.5 km square', () => {
    expect(w.utm.xmax - w.utm.xmin).toBe(2500);
    expect(w.utm.ymax - w.utm.ymin).toBe(2500);
  });

  it('has every corner on a bare-earth cell boundary (absolute multiples of 5 m)', () => {
    for (const v of [w.utm.xmin, w.utm.xmax, w.utm.ymin, w.utm.ymax]) {
      expect(v % BARE_EARTH_CELL_M).toBe(0);
    }
  });

  it('contains the focus box with a wide margin', () => {
    expect(w.local.xmin).toBeLessThan(FOCUS_BOX.minEast);
    expect(w.local.xmax).toBeGreaterThan(FOCUS_BOX.maxEast);
    expect(w.local.ymin).toBeLessThan(FOCUS_BOX.minNorth);
    expect(w.local.ymax).toBeGreaterThan(FOCUS_BOX.maxNorth);
  });

  it('keeps the east edge at or west of the data edge (950 m local) and within one cell of it', () => {
    expect(w.local.xmax).toBeLessThanOrEqual(DATA_EAST_EDGE_LOCAL_M);
    expect(w.local.xmax).toBeGreaterThan(DATA_EAST_EDGE_LOCAL_M - BARE_EARTH_CELL_M);
  });

  it('is centred on the focus box centre north-south to within one cell', () => {
    const cy = (w.local.ymin + w.local.ymax) / 2;
    expect(Math.abs(cy - (FOCUS_BOX.minNorth + FOCUS_BOX.maxNorth) / 2)).toBeLessThan(
      BARE_EARTH_CELL_M,
    );
  });

  it('does not clamp when the focus box is far enough west', () => {
    const west = { ...FOCUS_BOX, minEast: -2000, maxEast: -1500 };
    const c = computeSurfaceWindow(2500, west);
    expect((c.local.xmin + c.local.xmax) / 2).toBeCloseTo(-1750, -1);
  });

  it('local and utm differ by exactly ORIGIN', () => {
    expect(w.local.xmin + ORIGIN.easting).toBeCloseTo(w.utm.xmin, 6);
    expect(w.local.ymax + ORIGIN.northing).toBeCloseTo(w.utm.ymax, 6);
  });

  it('lies on the bare-earth header cell grid (same origin and 5 m cells)', () => {
    const header = TerrainHeaderSchema.parse(JSON.parse(readFileSync('data/terrain.json', 'utf8')));
    const cellsX = (w.local.xmin - header.originX) / header.cellSizeX;
    const cellsY = (header.originY - w.local.ymax) / header.cellSizeY;
    expect(Math.abs(cellsX - Math.round(cellsX))).toBeLessThan(1e-4);
    expect(Math.abs(cellsY - Math.round(cellsY))).toBeLessThan(1e-4);
    expect(w.local.xmin).toBeGreaterThanOrEqual(header.originX);
    expect(w.local.xmax).toBeLessThanOrEqual(header.originX + header.width * header.cellSizeX);
  });

  it('rejects a size that is not a whole number of cells', () => {
    expect(() => computeSurfaceWindow(2503)).toThrow(/SurfaceBadWindow/);
  });
});

describe('EPSG:3857 bounds', () => {
  const w = computeSurfaceWindow();

  it('lies inside the EPT extent', () => {
    expect(() => assertInsideEptExtent(w.ept3857)).not.toThrow();
  });

  it('rejects a box outside the EPT extent', () => {
    expect(() => assertInsideEptExtent({ ...w.ept3857, xmax: EPT_EXTENT_3857.xmax + 1 })).toThrow(
      /SurfaceOutsideEpt/,
    );
  });

  it('round-trips: back-projecting the 3857 box contains the 26915 window within a metre of rounding', () => {
    const back = fromEpt3857(w.ept3857);
    expect(back.xmin).toBeLessThanOrEqual(w.utm.xmin);
    expect(back.ymin).toBeLessThanOrEqual(w.utm.ymin);
    expect(back.xmax).toBeGreaterThanOrEqual(w.utm.xmax);
    expect(back.ymax).toBeGreaterThanOrEqual(w.utm.ymax);
    // the envelope of a rotated square is larger, but never by more than a few percent of the edge
    expect(back.xmax - back.xmin).toBeLessThan(2500 * 1.1);
  });

  it('is the exact outward-rounded envelope of the four projected corners', () => {
    const b = toEpt3857(w.utm);
    expect(Number.isInteger(b.xmin) && Number.isInteger(b.ymax)).toBe(true);
    expect(b).toEqual(w.ept3857);
  });
});

describe('pipeline template', () => {
  const values = {
    EPT_URL: 'https://example.test/ept.json',
    BOUNDS_3857: '([1,2],[3,4])',
    OUTPUT_TIF: 'data/raw/surface-core.tif',
    RESOLUTION: 1,
    ORIGIN_X: 10,
    ORIGIN_Y: 20,
    WIDTH: 5,
    HEIGHT: 5,
  };

  it('resolves every placeholder, keeping numbers as numbers', () => {
    const resolved = resolvePipeline(template, values);
    const writer = resolved.pipeline.find((s) => s.type === 'writers.gdal');
    expect(writer).toMatchObject({ origin_x: 10, width: 5, resolution: 1, output_type: 'max' });
    expect(JSON.stringify(resolved)).not.toContain('{{');
  });

  it('keeps first returns only and reprojects to 26915', () => {
    const resolved = resolvePipeline(template, values);
    expect(resolved.pipeline.find((s) => s.type === 'filters.range')).toMatchObject({
      limits: 'ReturnNumber[1:1]',
    });
    expect(resolved.pipeline.find((s) => s.type === 'filters.reprojection')).toMatchObject({
      out_srs: 'EPSG:26915',
    });
  });

  it('throws on a missing or an unused value', () => {
    const rest: Record<string, string | number> = { ...values };
    delete rest['WIDTH'];
    expect(() => resolvePipeline(template, rest)).toThrow(/SurfaceBadTemplate/);
    expect(() => resolvePipeline(template, { ...values, EXTRA: 1 })).toThrow(/SurfaceBadTemplate/);
  });
});

describe('PDAL metadata', () => {
  const stat = (count: number, minimum: number, maximum: number) => ({
    statistic: [{ name: 'ReturnNumber', count, minimum, maximum }],
  });
  it('reads points read and first returns from the two stats stages', () => {
    const metadata = { stages: { 'filters.stats': [stat(100, 1, 5), stat(80, 1, 1)] } };
    expect(parsePointCounts(metadata)).toEqual({ pointsRead: 100, firstReturns: 80 });
  });
  it('rejects a first-return stage holding other returns, and a missing stage', () => {
    expect(() =>
      parsePointCounts({ stages: { 'filters.stats': [stat(100, 1, 5), stat(80, 1, 2)] } }),
    ).toThrow(/SurfaceBadMetadata/);
    expect(() => parsePointCounts({ stages: {} })).toThrow();
  });
});

describe('SurfaceManifestSchema', () => {
  const good = () => ({
    version: 1,
    name: 'surface-core',
    path: 'data/raw/surface-core.tif',
    eptUrl: 'https://usgs-lidar-public.s3.amazonaws.com/MN_LakeSuperior_2_2021/ept.json',
    pdalVersion: '2.10.2',
    pipeline: { pipeline: [{ type: 'readers.ept' }] },
    epsg: 26915,
    window26915: { xmin: 0, ymin: 0, xmax: 2500, ymax: 2500 },
    window3857: { xmin: 0, ymin: 0, xmax: 2600, ymax: 2600 },
    resolutionM: 1,
    width: 2500,
    height: 2500,
    pointsRead: 10,
    firstReturnsKept: 8,
    byteLength: 1000,
    sha256: 'a'.repeat(64),
    seconds: 1.5,
    fetchedAt: '2026-10-06T00:00:00.000Z',
    firstAttemptBytes: null,
  });

  it('accepts a valid manifest', () => {
    expect(SurfaceManifestSchema.safeParse(good()).success).toBe(true);
  });
  it('accepts the 2 m fallback with half the cells', () => {
    expect(
      SurfaceManifestSchema.safeParse({
        ...good(),
        resolutionM: 2,
        width: 1250,
        height: 1250,
        firstAttemptBytes: 25_000_000,
      }).success,
    ).toBe(true);
  });
  it.each([
    ['unknown key', { extra: 1 }],
    ['width disagreeing with window', { width: 2400 }],
    ['bad sha256', { sha256: 'xyz' }],
    ['first returns above points read', { firstReturnsKept: 11 }],
    ['wrong epsg', { epsg: 3857 }],
    ['empty pipeline', { pipeline: { pipeline: [] } }],
  ])('rejects %s', (_label, patch) => {
    expect(SurfaceManifestSchema.safeParse({ ...good(), ...patch }).success).toBe(false);
  });
});

describe('square window', () => {
  const w = computeSquareWindow();

  it('is exactly the terrain square, 3475 x 3370 cells of 2 m', () => {
    expect(w.utm).toEqual({ xmin: 556530, ymin: 5169870, xmax: 563480, ymax: 5176610 });
    expect((w.utm.xmax - w.utm.xmin) / 2).toBe(3475);
    expect((w.utm.ymax - w.utm.ymin) / 2).toBe(3370);
  });

  it('spans about x -10270430..-10260210 in EPSG:3857', () => {
    expect(w.ept3857.xmin).toBe(-10270430);
    expect(w.ept3857.xmax).toBe(-10260210);
  });

  it('splits the readers at the dataset seam: west ends at the 2_2021 extent, east starts at -10264000', () => {
    expect(w.boundsWest.xmax).toBe(-10262419);
    expect(w.boundsEast.xmin).toBe(-10264000);
    expect(w.boundsWest.xmin).toBe(w.ept3857.xmin);
    expect(w.boundsEast.xmax).toBe(w.ept3857.xmax);
  });

  it('selects files, window and cell sizes per --window', () => {
    const core = planFor('core');
    const square = planFor('square');
    expect(core).toMatchObject({
      name: 'surface-core',
      tif: 'surface-core.tif',
      resolutions: [1, 2],
    });
    expect(core.extraEptUrls).toEqual([]);
    expect(square).toMatchObject({
      name: 'surface-square',
      tif: 'surface-square.tif',
      manifest: 'surface-square-manifest.json',
      resolutions: [2, 4],
      extraEptUrls: [EPT_URL_EAST],
    });
    expect(square.utm).toEqual(w.utm);
  });

  it('resolves the two-reader pipeline: two tagged readers at resolution 2, merged, first returns, 2 m writer', () => {
    const plan = planFor('square');
    const template: unknown = JSON.parse(readFileSync(SQUARE_TEMPLATE_FILE, 'utf8'));
    const resolved = resolvePipeline(template, {
      ...plan.readerValues,
      OUTPUT_TIF: 'data/raw/surface-square.tif',
      RESOLUTION: 2,
      ORIGIN_X: plan.utm.xmin,
      ORIGIN_Y: plan.utm.ymin,
      WIDTH: 3475,
      HEIGHT: 3370,
    });
    const stages = resolved.pipeline;
    expect(stages.map((s) => s.type)).toEqual([
      'readers.ept',
      'readers.ept',
      'filters.merge',
      'filters.stats',
      'filters.range',
      'filters.stats',
      'filters.reprojection',
      'writers.gdal',
    ]);
    expect(stages[0]).toMatchObject({ tag: 'west', filename: EPT_URL, resolution: 2 });
    expect(stages[1]).toMatchObject({ tag: 'east', filename: EPT_URL_EAST, resolution: 2 });
    expect(stages[2]).toMatchObject({ inputs: ['west', 'east'] });
    expect(stages[7]).toMatchObject({
      width: 3475,
      height: 3370,
      resolution: 2,
      output_type: 'max',
    });
    expect(JSON.stringify(resolved)).not.toContain('{{');
  });
});

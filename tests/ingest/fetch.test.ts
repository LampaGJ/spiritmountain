import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeArrayBuffer } from 'geotiff';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IngestError,
  createScheduler,
  runFetch,
  validateOverpass,
  validateTiff,
} from '../../scripts/ingest/fetch';
import { gridEnvelope, BBOX } from '../../scripts/ingest/local-frame';
import { ManifestSchema } from '../../scripts/ingest/manifest-schema';

const GRID = gridEnvelope(BBOX, 5000); // coarse grid: tiny rasters in tests

function envelope(overrides: Record<string, unknown> = {}) {
  const pt = [
    { lat: 46.7, lon: -92.2 },
    { lat: 46.71, lon: -92.21 },
  ];
  return {
    version: 0.6,
    generator: 'test',
    osm3s: { timestamp_osm_base: '2026-10-06T00:00:00Z' },
    elements: [
      { type: 'way', id: 1, nodes: [1, 2], geometry: pt, tags: { 'piste:type': 'downhill' } },
      { type: 'way', id: 2, nodes: [1, 2], geometry: pt, tags: { aerialway: 'chair_lift' } },
      { type: 'way', id: 3, nodes: [1, 2], geometry: pt, tags: { 'mtb:scale': '1' } },
    ],
    ...overrides,
  };
}
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function tiff(values: Float32Array, epsg = 26915) {
  const w = GRID.width;
  const h = GRID.height;
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: w,
      height: h,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: epsg,
      ModelPixelScale: [5000, 5000, 0],
      ModelTiepoint: [0, 0, 0, GRID.xmin, GRID.ymax, 0],
    }),
  );
}
const goodValues = () => new Float32Array(GRID.width * GRID.height).fill(250);

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IngestError);
    expect((e as IngestError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('validateOverpass', () => {
  it('accepts a good envelope and counts families', () => {
    const r = validateOverpass(bytesOf(envelope()));
    expect(r.counts).toMatchObject({ ways: 3, pisteType: 1, aerialway: 1, mtbScale: 1 });
  });
  it('OverpassNotJson', () =>
    expectCode(() => validateOverpass(new TextEncoder().encode('<html>')), 'OverpassNotJson'));
  it('OverpassSchemaMismatch on a renamed elements key', () => {
    const { elements, ...rest } = envelope();
    expectCode(
      () => validateOverpass(bytesOf({ ...rest, element: elements })),
      'OverpassSchemaMismatch',
    );
  });
  it('OverpassEmpty', () =>
    expectCode(() => validateOverpass(bytesOf(envelope({ elements: [] }))), 'OverpassEmpty'));
  it('OverpassNoGeometry when a way lacks geometry', () => {
    const e = envelope();
    delete (e.elements[0] as Record<string, unknown>).geometry;
    expectCode(() => validateOverpass(bytesOf(e)), 'OverpassNoGeometry');
  });
  it('OverpassMissingFamily when piste:type vanishes', () => {
    const e = envelope();
    e.elements.shift();
    expectCode(() => validateOverpass(bytesOf(e)), 'OverpassMissingFamily');
  });
});

describe('validateTiff', () => {
  const expected = { width: GRID.width, height: GRID.height, bbox: GRID };
  it('accepts a Float32 EPSG:26915 raster and records byte order and stats', async () => {
    const r = await validateTiff(tiff(goodValues()), 'image/tiff', expected);
    expect(r.byteOrder).toBe('big'); // geotiff.js writes big-endian; the real 3DEP pin is little-endian
    expect(r.stats.min).toBe(250);
  });
  it('ThreeDepNotTiff on a JSON content-type', async () => {
    await expect(
      validateTiff(tiff(goodValues()), 'application/json', expected),
    ).rejects.toMatchObject({ code: 'ThreeDepNotTiff' });
  });
  it('ThreeDepBadMagic', async () => {
    await expect(
      validateTiff(new Uint8Array([1, 2, 3, 4, 5]), 'image/tiff', expected),
    ).rejects.toMatchObject({ code: 'ThreeDepBadMagic' });
  });
  it('ThreeDepBadCrs when the raster is not EPSG:26915', async () => {
    await expect(
      validateTiff(tiff(goodValues(), 3857), 'image/tiff', expected),
    ).rejects.toMatchObject({ code: 'ThreeDepBadCrs' });
  });
  it('ThreeDepNonFinite on NaN and on values below -1000', async () => {
    const nan = goodValues();
    nan[0] = Number.NaN;
    await expect(validateTiff(tiff(nan), 'image/tiff', expected)).rejects.toMatchObject({
      code: 'ThreeDepNonFinite',
    });
    const low = goodValues();
    low[0] = -3.4e38;
    await expect(validateTiff(tiff(low), 'image/tiff', expected)).rejects.toMatchObject({
      code: 'ThreeDepNonFinite',
    });
  });
});

describe('createScheduler', () => {
  afterEach(() => vi.useRealTimers());
  it('starts consecutive requests at least 1000 ms apart', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const schedule = createScheduler(1000, Date.now, sleep);
    const all = Promise.all(
      [1, 2, 3].map(() => schedule(async () => void starts.push(Date.now()))),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000);
  });
});

describe('runFetch', () => {
  const noSleep = async () => {};
  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), 'fetch-'));
    const dataDir = path.join(root, 'data');
    mkdirSync(path.join(dataDir, 'raw'), { recursive: true });
    return { dataDir, progressDir: path.join(root, 'progress') };
  }
  const json200 = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const tiff200 = (b: Uint8Array) =>
    new Response(b as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/tiff' },
    });
  const written = (dataDir: string) =>
    readdirSync(path.join(dataDir, 'raw')).filter((f) => f !== '.gitkeep');

  it('refuses to start without a User-Agent, before any network call', async () => {
    const f = vi.fn();
    await expect(
      runFetch({ ...setup(), userAgent: '  ', fetchImpl: f, sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'MissingUserAgent' });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500', () => new Response('boom', { status: 500 }), 'OverpassHttpError'],
    ['a non-JSON body', () => new Response('<html>', { status: 200 }), 'OverpassNotJson'],
    [
      'a renamed elements key',
      () => json200({ ...envelope(), elements: undefined, element: [] }),
      'OverpassSchemaMismatch',
    ],
    ['an empty elements array', () => json200(envelope({ elements: [] })), 'OverpassEmpty'],
    ['a 403', () => new Response('no', { status: 403 }), 'OverpassBlocked'],
  ])('%s from Overpass exits with the named error and writes no file', async (_n, make, code) => {
    const s = setup();
    await expect(
      runFetch({ ...s, fetchImpl: async () => make(), sleep: noSleep }),
    ).rejects.toMatchObject({ code });
    expect(written(s.dataDir)).toEqual([]);
  });

  it('a 3DEP JSON content-type exits ThreeDepNotTiff and writes no file', async () => {
    const s = setup();
    const f = vi.fn(async (url: string) =>
      url.includes('overpass') ? json200(envelope()) : json200({ error: 'x' }),
    );
    await expect(runFetch({ ...s, fetchImpl: f, sleep: noSleep })).rejects.toMatchObject({
      code: 'ThreeDepNotTiff',
    });
    expect(written(s.dataDir)).toEqual([]);
  });

  it('retries a 503 and succeeds on the second attempt', async () => {
    const s = setup();
    let calls = 0;
    const f = async (url: string) => {
      if (url.includes('overpass'))
        return ++calls === 1 ? new Response('busy', { status: 503 }) : json200(envelope());
      return json200({ error: 'stop here' });
    };
    await expect(runFetch({ ...s, fetchImpl: f, sleep: noSleep })).rejects.toMatchObject({
      code: 'ThreeDepNotTiff',
    });
    expect(calls).toBe(2);
  });

  it('a fully good run writes four files, a manifest that parses, a done heartbeat, and a second run refuses', async () => {
    const s = setup();
    // 100 m/px keeps the fake raster small; the grid for that size is what runFetch will request.
    const g = gridEnvelope(BBOX, 100);
    const raster = new Uint8Array(
      writeArrayBuffer(new Float32Array(g.width * g.height).fill(250), {
        width: g.width,
        height: g.height,
        GTModelTypeGeoKey: 1,
        GTRasterTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 26915,
        ModelPixelScale: [100, 100, 0],
        ModelTiepoint: [0, 0, 0, g.xmin, g.ymax, 0],
      }),
    );
    const f = async (url: string) =>
      url.includes('overpass') ? json200(envelope()) : tiff200(raster);
    const phases: string[] = [];
    const progressFactory = () => ({
      tick: (_done: number, extra?: Record<string, unknown>) =>
        void phases.push(String(extra?.['phase'])),
      done: () => void phases.push('done'),
    });
    const m = await runFetch({
      ...s,
      metresPerPx: 100,
      fetchImpl: f,
      sleep: noSleep,
      progressFactory,
    });
    expect(written(s.dataDir).sort()).toEqual(['3dep.tif', 'manifest.json', 'overpass.json']);
    expect(
      ManifestSchema.parse(
        JSON.parse(readFileSync(path.join(s.dataDir, 'raw/manifest.json'), 'utf8')),
      ).threeDep.byteLength,
    ).toBe(m.threeDep.byteLength);
    expect(JSON.parse(readFileSync(path.join(s.dataDir, 'frame.json'), 'utf8')).epsg).toBe(26915);
    expect(phases).toContain('overpass-request');
    expect(phases.at(-1)).toBe('done');
    const before = readFileSync(path.join(s.dataDir, 'raw/manifest.json'), 'utf8');
    await expect(
      runFetch({ ...s, metresPerPx: 100, fetchImpl: f, sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'AlreadyPinned' });
    expect(readFileSync(path.join(s.dataDir, 'raw/manifest.json'), 'utf8')).toBe(before);
    writeFileSync(path.join(s.dataDir, 'touch'), '');
  });
});

describe('heartbeat wiring', () => {
  it('has no static import of the absolute helper path, so a clean machine can import fetch.ts', () => {
    const src = readFileSync('scripts/ingest/fetch.ts', 'utf8');
    expect(src).not.toMatch(/^import[^;]*from\s+'\/Users\//m);
    expect(src).toContain("import('/Users/graham/.claude/lib/progress.mjs')");
    expect(src).toContain('ERR_MODULE_NOT_FOUND');
  });

  it('exports no entry point and no test file calls one', async () => {
    const mod = await import('../../scripts/ingest/fetch');
    expect('main' in mod).toBe(false);
    // Only files that import fetch.ts matter; other entry points (for example #10's annotations main) are not this one.
    const callers = readdirSync('tests/ingest')
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => [name, readFileSync(path.join('tests/ingest', name), 'utf8')] as const)
      .filter(([, text]) => text.includes('scripts/ingest/fetch') && /\bmain\(/.test(text))
      .map(([name]) => name);
    expect(callers).toEqual([]);
  });
});

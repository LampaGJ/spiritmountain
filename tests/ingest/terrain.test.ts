import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { sha256Hex } from '../../scripts/ingest/replay';
import {
  TRANSFORM_SOURCES,
  TerrainReplaySchema,
  buildTerrain,
  fillNodata,
  parseGdalNodata,
  renderHeaderJson,
  runTerrain,
} from '../../scripts/ingest/terrain';
import { buildFixtureTiff, grid5x5WithNodata } from './terrain-fixture';

const frame = { originE: 560002, originN: 5173237 };
const ctx = { frame, frameSha256: 'f'.repeat(64), inputSha256: 'a'.repeat(64) };
const COMMIT = 'b'.repeat(40);

const tiff5 = (): Uint8Array =>
  buildFixtureTiff({ width: 5, height: 5, values: grid5x5WithNodata(-9999), nodata: '-9999' });

function readBack(f32: Uint8Array): number[] {
  const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
  const out: number[] = [];
  for (let offset = 0; offset < f32.byteLength; offset += 4)
    out.push(view.getFloat32(offset, true));
  return out;
}

function listFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((name) => /\.ts$/.test(name))
    .map((name) => join(root, name));
}

describe('parseGdalNodata', () => {
  it('parses with and without a trailing NUL', () => {
    expect(parseGdalNodata('-9999\x00')).toBe(-9999);
    expect(parseGdalNodata('-9999')).toBe(-9999);
  });
  it('returns null for no tag and for nan', () => {
    expect(parseGdalNodata(undefined)).toBeNull();
    expect(parseGdalNodata('nan\x00')).toBeNull();
  });
  it('rejects empty and non-numeric text', () => {
    expect(() => parseGdalNodata('')).toThrow(/BadNodata/);
    expect(() => parseGdalNodata('abc')).toThrow(/BadNodata/);
  });
});

describe('fillNodata', () => {
  it('fills a chain over several rings from the only valid cell', () => {
    const values = Float32Array.from([250, -1, -1, -1]);
    const mask = Uint8Array.from([0, 1, 1, 1]);
    expect(fillNodata(values, mask, 4, 1)).toBe(3);
    expect(Array.from(values)).toEqual([250, 250, 250, 250]);
  });
  it('throws NoValidPixels when every cell is nodata', () => {
    expect(() => fillNodata(new Float32Array(4), Uint8Array.from([1, 1, 1, 1]), 2, 2)).toThrow(
      /NoValidPixels/,
    );
  });
});

describe('buildTerrain on a 5 x 5 fixture', () => {
  it('fills the three nodata cells with the hand-computed values', async () => {
    const { f32, header } = await buildTerrain(tiff5(), ctx);
    const values = readBack(f32);
    expect(values[12]).toBe(211);
    expect(values[0]).toBe(201);
    expect(values[22]).toBe(231);
    expect(header.nodataFilled).toBe(3);
    expect(header.minElev).toBe(201);
    expect(header.maxElev).toBe(244);
    expect(header.nodataRule).toBe('gdal-nodata-tag-or-non-finite');
    expect(header.nodataValue).toBe(-9999);
  });
  it('records the origin corner in local metres and the cell size', async () => {
    const { header } = await buildTerrain(tiff5(), ctx);
    expect(header.originX).toBe(558000 - 560002);
    expect(header.originY).toBe(5175000 - 5173237);
    expect(header.cellSizeX).toBe(5);
    expect(header.cellSizeY).toBe(5);
    expect(TerrainHeaderSchema.safeParse(header).success).toBe(true);
  });
  it('gives the same bytes for a Buffer subarray input', async () => {
    const bytes = tiff5();
    const shifted = Buffer.concat([Buffer.alloc(7), Buffer.from(bytes)]).subarray(7);
    const a = await buildTerrain(bytes, ctx);
    const b = await buildTerrain(shifted, ctx);
    expect(Buffer.from(a.f32).equals(Buffer.from(b.f32))).toBe(true);
  });
  it('is deterministic across two builds', async () => {
    const a = await buildTerrain(tiff5(), ctx);
    const b = await buildTerrain(tiff5(), ctx);
    expect(Buffer.from(a.f32).equals(Buffer.from(b.f32))).toBe(true);
    expect(renderHeaderJson(a.header)).toBe(renderHeaderJson(b.header));
  });
  it('emits header keys in the fixed order', async () => {
    const { header } = await buildTerrain(tiff5(), ctx);
    expect(Object.keys(JSON.parse(renderHeaderJson(header)))).toEqual([
      'version',
      'width',
      'height',
      'originX',
      'originY',
      'originCorner',
      'cellSizeX',
      'cellSizeY',
      'rowOrder',
      'columnOrder',
      'byteOrder',
      'dtype',
      'byteLength',
      'minElev',
      'maxElev',
      'plausibleRangeM',
      'nodataValue',
      'nodataRule',
      'fillMethod',
      'nodataFilled',
      'frame',
      'source',
    ]);
  });
  it('treats NaN as nodata when there is no tag', async () => {
    const values = grid5x5WithNodata(Number.NaN);
    const { header } = await buildTerrain(buildFixtureTiff({ width: 5, height: 5, values }), ctx);
    expect(header.nodataRule).toBe('non-finite-only');
    expect(header.nodataValue).toBeNull();
    expect(header.nodataFilled).toBe(3);
  });
});

describe('buildTerrain refusals', () => {
  it('refuses an all-nodata raster', async () => {
    const bytes = buildFixtureTiff({
      width: 2,
      height: 2,
      values: [-9999, -9999, -9999, -9999],
      nodata: '-9999',
    });
    await expect(buildTerrain(bytes, ctx)).rejects.toMatchObject({ code: 'NoValidPixels' });
  });
  it('refuses PixelIsPoint', async () => {
    const bytes = buildFixtureTiff({
      width: 2,
      height: 2,
      values: [200, 201, 202, 203],
      rasterType: 2,
    });
    await expect(buildTerrain(bytes, ctx)).rejects.toMatchObject({ code: 'NotPixelIsArea' });
  });
  it('refuses a non-26915 CRS', async () => {
    const bytes = buildFixtureTiff({
      width: 2,
      height: 2,
      values: [200, 201, 202, 203],
      epsg: 3857,
    });
    await expect(buildTerrain(bytes, ctx)).rejects.toMatchObject({ code: 'WrongCrs' });
  });
  it('refuses an untagged sentinel as implausible', async () => {
    const bytes = buildFixtureTiff({ width: 2, height: 2, values: [200, -9999, 202, 203] });
    await expect(buildTerrain(bytes, ctx)).rejects.toMatchObject({ code: 'ImplausibleElevation' });
  });
});

describe('runTerrain', () => {
  function setup(): { dir: string; tiff: Uint8Array } {
    const dir = mkdtempSync(join(tmpdir(), 'terrain-'));
    mkdirSync(join(dir, 'raw'));
    const tiff = tiff5();
    writeFileSync(join(dir, 'raw', '3dep.tif'), tiff);
    return { dir, tiff };
  }
  // The geotiff.js writer emits big-endian; the 5 x 5 fixture extent is 558000..558025 by 5174975..5175000.
  const pinFor = (tiff: Uint8Array) => ({
    sha256: sha256Hex(tiff),
    width: 5,
    height: 5,
    byteOrder: 'big' as const,
    bbox: { xmin: 558000, ymin: 5174975, xmax: 558025, ymax: 5175000 },
    stats: { min: 200, max: 244 },
  });
  const options = (dir: string, tiff: Uint8Array) => ({
    dataDir: dir,
    pin: pinFor(tiff),
    frame,
    frameSha256: 'f'.repeat(64),
    lockSubtree: 'c'.repeat(64),
    resolveCommit: () => COMMIT,
  });
  const noOutputs = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('terrain'));

  it('writes byte-identical outputs on two runs and a verifiable replay record', async () => {
    const one = setup();
    const two = setup();
    await runTerrain(options(one.dir, one.tiff));
    await runTerrain(options(two.dir, two.tiff));
    for (const name of ['terrain.f32', 'terrain.json', 'terrain.replay.json']) {
      expect(sha256Hex(readFileSync(join(one.dir, name)))).toBe(
        sha256Hex(readFileSync(join(two.dir, name))),
      );
    }
    const replay = TerrainReplaySchema.parse(
      JSON.parse(readFileSync(join(one.dir, 'terrain.replay.json'), 'utf8')),
    );
    const recomputed = sha256Hex(
      Buffer.concat([
        readFileSync(join(one.dir, 'terrain.f32')),
        readFileSync(join(one.dir, 'terrain.json')),
      ]),
    );
    expect(replay.outputHash).toBe(recomputed);
    expect(replay.effect).toBe('preserves');
    expect(replay.codeCommit).toBe(COMMIT);
    expect(readFileSync(join(one.dir, 'terrain.f32')).byteLength).toBe(5 * 5 * 4);
  });

  it('writes no integer-like object key in any JSON output (a JSON writer would reorder it)', async () => {
    const keysOf = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keysOf)
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)])
          : [];
    expect(keysOf({ 2: 'x' })).toEqual(['2']); // positive control: the instrument sees integer-like keys
    const { dir, tiff } = setup();
    await runTerrain(options(dir, tiff));
    for (const name of ['terrain.json', 'terrain.replay.json']) {
      const keys = keysOf(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      expect(keys.length).toBeGreaterThan(0);
      expect(
        keys.filter((key) => /^\d+$/.test(key)),
        name,
      ).toEqual([]);
    }
  });

  it('refuses a tampered input and writes nothing', async () => {
    const { dir, tiff } = setup();
    const tampered = Buffer.from(tiff);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
    writeFileSync(join(dir, 'raw', '3dep.tif'), tampered);
    await expect(runTerrain(options(dir, tiff))).rejects.toMatchObject({
      code: 'PinnedInputHashMismatch',
    });
    expect(noOutputs(dir)).toEqual([]);
  });

  it('refuses wrong manifest dimensions, bbox or byte order and writes nothing', async () => {
    const { dir, tiff } = setup();
    const base = options(dir, tiff);
    await expect(runTerrain({ ...base, pin: { ...base.pin, width: 6 } })).rejects.toMatchObject({
      code: 'ManifestDimensionMismatch',
    });
    await expect(
      runTerrain({ ...base, pin: { ...base.pin, bbox: { ...base.pin.bbox, xmin: 557000 } } }),
    ).rejects.toMatchObject({
      code: 'ManifestDimensionMismatch',
    });
    await expect(
      runTerrain({ ...base, pin: { ...base.pin, byteOrder: 'little' } }),
    ).rejects.toMatchObject({ code: 'ByteOrderMismatch' });
    expect(noOutputs(dir)).toEqual([]);
  });
});

describe('structure', () => {
  const sources = () => [...listFiles('src'), ...listFiles('scripts')];
  it('has exactly one TerrainHeaderSchema definition under src and scripts', () => {
    const hits = sources().filter((file) =>
      /const TerrainHeaderSchema\s*=/.test(readFileSync(file, 'utf8')),
    );
    expect(hits).toEqual([join('src', 'schema', 'terrain.ts')]);
  });
  it('has exactly one FrameSchema definition under src and scripts', () => {
    const hits = sources().filter((file) =>
      /const FrameSchema\s*=/.test(readFileSync(file, 'utf8')),
    );
    expect(hits).toEqual([join('src', 'schema', 'frame.ts')]);
  });
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of terrain.ts', () => {
    const closure = (entry: string): string[] => {
      const seen = new Set<string>();
      const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
          .importedFiles) {
          if (!fileName.startsWith('.')) continue;
          const base = join(dirname(file), fileName);
          const found = [`${base}.ts`, join(base, 'index.ts')].find((candidate) =>
            existsSync(candidate),
          );
          if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
          visit(relative('.', found));
        }
      };
      visit(entry);
      return [...seen].sort();
    };
    expect([...TRANSFORM_SOURCES].sort()).toEqual(closure('scripts/ingest/terrain.ts'));
  });
  it('keeps proj4 and local-frame off the transform path', () => {
    for (const file of ['scripts/ingest/terrain.ts', 'scripts/ingest/terrain-deps.ts']) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/proj4/);
      expect(text).not.toMatch(/local-frame/);
    }
  });
});

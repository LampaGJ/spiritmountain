import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../scripts/ingest/replay';
import {
  SurfaceReplaySchema,
  maxPool2,
  TRANSFORM_SOURCES,
  runSurfaceTerrain,
} from '../../scripts/ingest/surface-terrain';
import { seamEastingAtNorthing } from '../../scripts/ingest/surface-window';
import { readFrame } from '../../scripts/ingest/terrain-deps';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { buildFixtureTiff } from './terrain-fixture';

describe('surface-terrain transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of surface-terrain.ts', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles) {
        if (!fileName.startsWith('.') || fileName.endsWith('.json')) continue;
        const base = join(dirname(file), fileName);
        const found = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
        if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
        visit(relative('.', found));
      }
    };
    visit('scripts/ingest/surface-terrain.ts');
    expect([...TRANSFORM_SOURCES].sort()).toEqual([...seen].sort());
  });
});

describe('maxPool2', () => {
  it('takes the max over valid cells and leaves an all-nodata block nodata', () => {
    const values = Float32Array.from([1, 9, 0, 0, 5, 2, 0, 0]);
    const nodata = Uint8Array.from([0, 0, 1, 1, 1, 0, 1, 1]);
    const out = maxPool2(values, nodata, 4, 2);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(out.values[0]).toBe(9);
    expect([...out.nodata]).toEqual([0, 1]);
  });
  it('clips the last block of an odd-sized raster, giving ceil(w / 2) by ceil(h / 2)', () => {
    const out = maxPool2(Float32Array.from([1, 2, 7]), new Uint8Array(3), 3, 1);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect([...out.values]).toEqual([2, 7]);
  });
});

describe('surface terrain on a synthetic 4x4 TIFF', () => {
  const MIN_X = 558000;
  const MAX_Y = 5175000;
  const frameBytes = readFileSync('data/frame.json');

  /** Row 0 is north. Values are 300 + 10 * row + col; the whole SE 2x2 block (cells 10, 11, 14, 15) is nodata, plus cell 5. */
  const values = (): number[] => {
    const out: number[] = [];
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) out.push(300 + 10 * row + col);
    }
    for (const i of [5, 10, 11, 14, 15]) out[i] = -9999;
    return out;
  };

  const stage = (cells: number[] = values(), size = 4) => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-'));
    mkdirSync(join(dir, 'raw'), { recursive: true });
    copyFileSync('data/frame.json', join(dir, 'frame.json'));
    const tiff = buildFixtureTiff({
      width: size,
      height: size,
      values: cells,
      nodata: '-9999',
      resolution: 1,
      minX: MIN_X,
      maxY: MAX_Y,
    });
    writeFileSync(join(dir, 'raw', 'surface-core.tif'), tiff);
    const manifest = {
      version: 1,
      name: 'surface-core',
      path: 'data/raw/surface-core.tif',
      eptUrl: 'https://usgs-lidar-public.s3.amazonaws.com/MN_LakeSuperior_2_2021/ept.json',
      pdalVersion: '2.10.2',
      pipeline: { pipeline: [{ type: 'readers.ept' }] },
      epsg: 26915,
      window26915: { xmin: MIN_X, ymin: MAX_Y - size, xmax: MIN_X + size, ymax: MAX_Y },
      window3857: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
      resolutionM: 1,
      width: size,
      height: size,
      pointsRead: 100,
      firstReturnsKept: 90,
      byteLength: tiff.byteLength,
      sha256: sha256Hex(tiff),
      seconds: 1,
      fetchedAt: '2026-10-06T00:00:00.000Z',
      firstAttemptBytes: null,
    };
    writeFileSync(join(dir, 'raw', 'surface-manifest.json'), JSON.stringify(manifest));
    return dir;
  };

  const options = (dataDir: string) => ({
    dataDir,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: 'c'.repeat(64),
    resolveCommit: () => 'd'.repeat(40),
  });

  it('decodes to a valid header, little-endian f32, filled nodata and a replay record', async () => {
    const dir = stage();
    const { header, replay } = await runSurfaceTerrain(options(dir));
    expect(TerrainHeaderSchema.safeParse(header).success).toBe(true);
    expect(header).toMatchObject({
      width: 2,
      height: 2,
      cellSizeX: 2,
      cellSizeY: 2,
      nodataFilled: 1,
      nodataValue: -9999,
      minElev: 310,
      maxElev: 313,
      byteLength: 16,
    });
    expect(header.source.path).toBe('data/raw/surface-core.tif');
    const frame = readFrame(frameBytes);
    expect(header.originX).toBeCloseTo(MIN_X - frame.originE, 6);
    expect(header.originY).toBeCloseTo(MAX_Y - frame.originN, 6);

    const f32 = readFileSync(join(dir, 'surface', 'core.f32'));
    expect(f32.byteLength).toBe(16);
    const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
    // block maxima are 310, 313, 331; the 331 block is an 18 m isolated spike over the median 313 and is removed before the fill,
    // then the all-nodata SE block takes its first valid neighbour in fixed order (north-west, 310)
    expect([0, 1, 2, 3].map((i) => view.getFloat32(i * 4, true))).toEqual([310, 313, 313, 310]);
    expect(replay.pooling).toBe('max');
    expect(replay.decodeResolutionM).toBe(2);
    expect(SurfaceReplaySchema.safeParse(replay).success).toBe(true);
    expect(replay.effect).toBe('preserves');
    expect(replay.despike).toEqual({
      passes: [
        { spikesRemoved: 1, maxDelta: 18 },
        { spikesRemoved: 0, maxDelta: 0 },
      ],
      maxBefore: 331,
      maxAfter: 313,
    });
    expect(JSON.parse(readFileSync(join(dir, 'surface', 'surface.replay.json'), 'utf8'))).toEqual(
      replay,
    );
  });

  it('treats a value above the plausible ceiling as nodata, so a spike never wins the max', async () => {
    const dir = stage([300, 900, 310, 320], 2);
    const { header } = await runSurfaceTerrain(options(dir));
    expect(header).toMatchObject({ width: 1, height: 1, maxElev: 320, nodataFilled: 0 });
  });

  it('removes an isolated needle before the fill and records it in the replay despike block', async () => {
    const cells = new Array<number>(16).fill(300);
    cells[0] = 340; // north-west 2x2 block pools to 340, one needle on a 300 m surface
    const dir = stage(cells);
    const { header, replay } = await runSurfaceTerrain(options(dir));
    expect(header).toMatchObject({ minElev: 300, maxElev: 300 });
    expect(replay.despike.passes[0]).toEqual({ spikesRemoved: 1, maxDelta: 40 });
    expect(replay.despike.maxBefore).toBe(340);
    expect(replay.despike.maxAfter).toBe(300);
    expect(SurfaceReplaySchema.safeParse(replay).success).toBe(true);
  });

  it('is byte-identical on a rerun', async () => {
    const dir = stage();
    await runSurfaceTerrain(options(dir));
    const first = readFileSync(join(dir, 'surface', 'core.f32'));
    await runSurfaceTerrain(options(dir));
    expect(readFileSync(join(dir, 'surface', 'core.f32')).equals(first)).toBe(true);
  });

  it('refuses a TIFF whose hash differs from the manifest pin', async () => {
    const dir = stage();
    writeFileSync(
      join(dir, 'raw', 'surface-core.tif'),
      buildFixtureTiff({
        width: 4,
        height: 4,
        values: values().map((v) => v + 1),
        nodata: '-9999',
        resolution: 1,
        minX: MIN_X,
        maxY: MAX_Y,
      }),
    );
    await expect(runSurfaceTerrain(options(dir))).rejects.toThrow(/PinnedInputHashMismatch/);
  });
});

describe('square window decode and the dataset seam', () => {
  const frameBytes = readFileSync('data/frame.json');
  const MAX_Y = 5174000;
  const SIZE = 64; // 64 x 64 cells of 2 m, pooled to 32 x 32 cells of 4 m
  const minX = Math.floor(seamEastingAtNorthing(MAX_Y - SIZE)) - SIZE; // the seam crosses the raster's middle

  const stage = (cells: number[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-sq-'));
    mkdirSync(join(dir, 'raw'), { recursive: true });
    copyFileSync('data/frame.json', join(dir, 'frame.json'));
    const tiff = buildFixtureTiff({
      width: SIZE,
      height: SIZE,
      values: cells,
      nodata: '-9999',
      resolution: 2,
      minX,
      maxY: MAX_Y,
    });
    writeFileSync(join(dir, 'raw', 'surface-square.tif'), tiff);
    writeFileSync(
      join(dir, 'raw', 'surface-square-manifest.json'),
      JSON.stringify({
        version: 1,
        name: 'surface-square',
        path: 'data/raw/surface-square.tif',
        eptUrl: 'https://usgs-lidar-public.s3.amazonaws.com/MN_LakeSuperior_2_2021/ept.json',
        extraEptUrls: [
          'https://usgs-lidar-public.s3.amazonaws.com/MN_LakeSuperior_1_2021/ept.json',
        ],
        pdalVersion: '2.10.2',
        pipeline: { pipeline: [{ type: 'readers.ept' }] },
        epsg: 26915,
        window26915: { xmin: minX, ymin: MAX_Y - 2 * SIZE, xmax: minX + 2 * SIZE, ymax: MAX_Y },
        window3857: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
        resolutionM: 2,
        width: SIZE,
        height: SIZE,
        pointsRead: 100,
        firstReturnsKept: 90,
        byteLength: tiff.byteLength,
        sha256: sha256Hex(tiff),
        seconds: 1,
        fetchedAt: '2026-10-06T00:00:00.000Z',
        firstAttemptBytes: null,
      }),
    );
    return dir;
  };
  const options = (dataDir: string) => ({
    dataDir,
    window: 'square' as const,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: 'c'.repeat(64),
    resolveCommit: () => 'd'.repeat(40),
  });
  const all = (v: number) => new Array<number>(SIZE * SIZE).fill(v);

  it('writes square.f32/json/replay at 4 m with the seam valid fraction recorded', async () => {
    const dir = stage(all(300));
    const { header, replay } = await runSurfaceTerrain(options(dir));
    expect(header).toMatchObject({ width: 32, height: 32, cellSizeX: 4, byteLength: 4096 });
    expect(header.source.path).toBe('data/raw/surface-square.tif');
    expect(replay.decodeResolutionM).toBe(4);
    expect(replay.seamValidFraction).toBe(1);
    expect(Object.keys(replay.outputs).sort()).toEqual(['square.f32', 'square.json']);
    expect(readFileSync(join(dir, 'surface', 'square.f32')).byteLength).toBe(4096);
    expect(JSON.parse(readFileSync(join(dir, 'surface', 'square.replay.json'), 'utf8'))).toEqual(
      replay,
    );
  });

  it('refuses a stripe: an empty seam column between valid neighbours fails the gate', async () => {
    // 2 m columns 30..35 are nodata, which empties the seam's 4 m column (the seam is at 2 m column 32)
    const cells = all(300).map((v, i) => {
      const col = i % SIZE;
      return col >= 30 && col <= 35 ? -9999 : v;
    });
    await expect(runSurfaceTerrain(options(stage(cells)))).rejects.toThrow(/SurfaceSeamStripe/);
  });

  it('accepts a void that spans the seam (water), because the seam is no emptier than its neighbours', async () => {
    const cells = all(300).map((v, i) => (Math.floor(i / SIZE) < SIZE / 2 ? -9999 : v));
    const { replay } = await runSurfaceTerrain(options(stage(cells)));
    expect(replay.seamValidFraction).toBeCloseTo(0.5, 1);
    expect(replay.neighbourValidFraction).toBeCloseTo(0.5, 1);
  });
});

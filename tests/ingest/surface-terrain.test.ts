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
  it('rejects odd dimensions', () => {
    expect(() => maxPool2(new Float32Array(3), new Uint8Array(3), 3, 1)).toThrow(/BadRaster/);
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
      maxElev: 331,
      byteLength: 16,
    });
    expect(header.source.path).toBe('data/raw/surface-core.tif');
    const frame = readFrame(frameBytes);
    expect(header.originX).toBeCloseTo(MIN_X - frame.originE, 6);
    expect(header.originY).toBeCloseTo(MAX_Y - frame.originN, 6);

    const f32 = readFileSync(join(dir, 'surface', 'core.f32'));
    expect(f32.byteLength).toBe(16);
    const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
    // block maxima, north-west first; the all-nodata SE block takes its first valid neighbour in fixed order (north-west, 310)
    expect([0, 1, 2, 3].map((i) => view.getFloat32(i * 4, true))).toEqual([310, 313, 331, 310]);
    expect(replay.pooling).toBe('max');
    expect(replay.decodeResolutionM).toBe(2);
    expect(SurfaceReplaySchema.safeParse(replay).success).toBe(true);
    expect(replay.effect).toBe('preserves');
    expect(JSON.parse(readFileSync(join(dir, 'surface', 'surface.replay.json'), 'utf8'))).toEqual(
      replay,
    );
  });

  it('treats a value above the plausible ceiling as nodata, so a spike never wins the max', async () => {
    const dir = stage([300, 900, 310, 320], 2);
    const { header } = await runSurfaceTerrain(options(dir));
    expect(header).toMatchObject({ width: 1, height: 1, maxElev: 320, nodataFilled: 0 });
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

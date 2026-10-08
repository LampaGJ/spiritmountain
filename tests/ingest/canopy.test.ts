import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CANOPY_MAX_M,
  CANOPY_SCALE_M,
  TRANSFORM_SOURCES,
  computeCanopyGrid,
  decodeRaster,
  runCanopy,
  type Raster,
} from '../../scripts/ingest/canopy';
import { sha256Hex } from '../../scripts/ingest/replay';
import { CanopyHeaderSchema } from '../../src/schema/canopy';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';

const FRAME_SHA = 'f'.repeat(64);

function header(
  width: number,
  height: number,
  cell: number,
  source: string,
  extra: Partial<TerrainHeader> = {},
): TerrainHeader {
  return TerrainHeaderSchema.parse({
    version: 1,
    width,
    height,
    originX: 1000,
    originY: 2000,
    originCorner: 'top-left-of-top-left-pixel',
    cellSizeX: cell,
    cellSizeY: cell,
    rowOrder: 'north-to-south',
    columnOrder: 'west-to-east',
    byteOrder: 'LE',
    dtype: 'float32',
    byteLength: width * height * 4,
    minElev: 0,
    maxElev: 500,
    plausibleRangeM: [150, 500],
    nodataValue: null,
    nodataRule: 'non-finite-only',
    fillMethod: 'chebyshev-bfs-fixed-order',
    nodataFilled: 0,
    frame: { file: 'data/frame.json', sha256: FRAME_SHA },
    source: { path: source, sha256: 'a'.repeat(64) },
    ...extra,
  });
}

/** A 12 x 12 first-return raster at 4 m (3 x 3 summary cells) over a flat 100 m bare earth at 5 m. */
function rasters(surfaceAt: (col: number, row: number) => number): {
  surface: Raster;
  terrain: Raster;
} {
  const surface = {
    header: header(12, 12, 4, 'data/raw/surface-square.tif'),
    data: new Float32Array(144),
  };
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 12; col += 1) surface.data[row * 12 + col] = surfaceAt(col, row);
  }
  const terrain = {
    header: header(10, 10, 5, 'data/raw/3dep.tif'),
    data: new Float32Array(100).fill(100),
  };
  return { surface, terrain };
}

describe('canopy transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of canopy.ts', () => {
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
    visit('scripts/ingest/canopy.ts');
    expect([...TRANSFORM_SOURCES].sort()).toEqual([...seen].sort());
  });
});

describe('computeCanopyGrid', () => {
  it('takes the block maximum of first return minus bare earth, one byte per 0.2 m', () => {
    // One 7 m cell in the first 20 m block, a 3 m cell in the same block, 12 m in the last block.
    const { surface, terrain } = rasters((col, row) => {
      if (col === 1 && row === 1) return 107;
      if (col === 2 && row === 3) return 103;
      if (col === 11 && row === 11) return 112;
      return 100;
    });
    const grid = computeCanopyGrid(surface, terrain);
    expect([grid.width, grid.height]).toEqual([3, 3]);
    expect(grid.originX).toBe(1000);
    expect(grid.originY).toBe(2000);
    expect(grid.bytes[0]).toBe(Math.round(7 / CANOPY_SCALE_M));
    expect(grid.bytes[8]).toBe(Math.round(12 / CANOPY_SCALE_M));
    expect(grid.bytes[4]).toBe(0);
  });

  it('clamps below ground to 0 and tall spikes to the 40 m clamp', () => {
    const { surface, terrain } = rasters((col) => (col < 5 ? 90 : 160));
    const grid = computeCanopyGrid(surface, terrain);
    expect(grid.bytes[0]).toBe(0);
    expect(grid.bytes[1]).toBe(CANOPY_MAX_M / CANOPY_SCALE_M);
  });

  it('keeps partial blocks at the south and east edges', () => {
    const surface = {
      header: header(7, 7, 4, 'data/raw/surface-square.tif'),
      data: new Float32Array(49).fill(100),
    };
    surface.data[6 * 7 + 6] = 105;
    const terrain = {
      header: header(6, 6, 5, 'data/raw/3dep.tif'),
      data: new Float32Array(36).fill(100),
    };
    const grid = computeCanopyGrid(surface, terrain);
    expect([grid.width, grid.height]).toEqual([2, 2]);
    expect(grid.bytes[3]).toBe(Math.round(5 / CANOPY_SCALE_M));
  });

  it('is byte-stable across runs', () => {
    const make = () =>
      computeCanopyGrid(
        ...(Object.values(rasters((c, r) => 100 + ((c * 7 + r * 3) % 13))) as [Raster, Raster]),
      );
    expect(sha256Hex(make().bytes)).toBe(sha256Hex(make().bytes));
  });

  it('refuses a cell size that does not divide 20 m', () => {
    const { terrain } = rasters(() => 100);
    const surface = {
      header: header(4, 4, 3, 'data/raw/surface-square.tif'),
      data: new Float32Array(16),
    };
    expect(() => computeCanopyGrid(surface, terrain)).toThrow(/CellNotDivisible/);
  });
});

describe('decodeRaster', () => {
  it('refuses a wrong byte length and a non-finite cell', () => {
    const h = header(2, 2, 4, 'data/raw/surface-square.tif');
    expect(() => decodeRaster(h, new Uint8Array(8), 'x')).toThrow(/BinLengthMismatch/);
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setFloat32(4, Number.NaN, true);
    expect(() => decodeRaster(h, bytes, 'x')).toThrow(/NonFinite/);
  });
});

describe('runCanopy', () => {
  const sandbox = (): string => {
    const dataDir = mkdtempSync(join(tmpdir(), 'canopy-'));
    mkdirSync(join(dataDir, 'surface'));
    const { surface, terrain } = rasters((c, r) => 100 + (c === 5 && r === 5 ? 9 : 0));
    const bin = (r: Raster): Uint8Array => {
      const bytes = new Uint8Array(r.data.length * 4);
      const view = new DataView(bytes.buffer);
      r.data.forEach((v, i) => view.setFloat32(i * 4, v, true));
      return bytes;
    };
    writeFileSync(join(dataDir, 'surface/square.f32'), bin(surface));
    writeFileSync(join(dataDir, 'surface/square.json'), JSON.stringify(surface.header));
    writeFileSync(join(dataDir, 'terrain.f32'), bin(terrain));
    writeFileSync(join(dataDir, 'terrain.json'), JSON.stringify(terrain.header));
    return dataDir;
  };
  const options = (dataDir: string) => ({
    dataDir,
    lockSubtree: 'b'.repeat(64),
    resolveCommit: () => 'c'.repeat(40),
  });

  it('writes the bytes, a valid header and a reduces replay whose hashes match', () => {
    const dataDir = sandbox();
    const { header: out, replay } = runCanopy(options(dataDir));
    const bytes = readFileSync(join(dataDir, 'canopy.u8'));
    const text = readFileSync(join(dataDir, 'canopy.json'), 'utf8');
    expect(CanopyHeaderSchema.parse(JSON.parse(text))).toEqual(out);
    expect(out.u8Sha256).toBe(sha256Hex(bytes));
    expect(bytes.byteLength).toBe(out.byteLength);
    expect(replay.effect).toBe('reduces');
    expect(replay.outputHash).toBe(sha256Hex(text));
    expect(existsSync(join(dataDir, 'canopy.replay.json'))).toBe(true);
  });

  it('replays byte-identically', () => {
    const dataDir = sandbox();
    runCanopy(options(dataDir));
    const first = ['canopy.u8', 'canopy.json', 'canopy.replay.json'].map((f) =>
      sha256Hex(readFileSync(join(dataDir, f))),
    );
    runCanopy(options(dataDir));
    const second = ['canopy.u8', 'canopy.json', 'canopy.replay.json'].map((f) =>
      sha256Hex(readFileSync(join(dataDir, f))),
    );
    expect(second).toEqual(first);
  });

  it('refuses surface and terrain headers that name different frames', () => {
    const dataDir = sandbox();
    const other = header(10, 10, 5, 'data/raw/3dep.tif', {
      frame: { file: 'data/frame.json', sha256: '1'.repeat(64) },
    });
    writeFileSync(join(dataDir, 'terrain.json'), JSON.stringify(other));
    expect(() => runCanopy(options(dataDir))).toThrow(/FrameMismatch/);
  });
});

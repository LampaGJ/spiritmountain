import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { BBOX, toLocal } from '../../scripts/ingest/local-frame';
import { sha256Hex } from '../../scripts/ingest/replay';
import { readFrame } from '../../scripts/ingest/terrain-deps';
import { TerrainReplaySchema, buildTerrain, renderHeaderJson } from '../../scripts/ingest/terrain';

// Requires `npm run ingest:terrain` to have been run on the pinned data (#7).
const header = TerrainHeaderSchema.parse(JSON.parse(readFileSync('data/terrain.json', 'utf8')));
const f32 = readFileSync('data/terrain.f32');
const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
const cellAt = (row: number, col: number): number =>
  view.getFloat32((row * header.width + col) * 4, true);

describe('committed terrain artifacts', () => {
  it('has the stated size and stays under the 10 MB budget', () => {
    expect(f32.byteLength).toBe(header.width * header.height * 4);
    expect(f32.byteLength).toBeLessThan(10_000_000);
  });

  it('needed no nodata fill on the pinned data (#7 aborts on bad pixels)', () => {
    expect(header.nodataFilled).toBe(0);
    expect(header.nodataRule).toBe('non-finite-only');
  });

  it('holds finite cells within the recorded range', () => {
    // minElev and maxElev are Math.fround values (G7 correction), so this exact comparison against Float32 cells holds without a tolerance.
    for (let row = 0; row < header.height; row += 1) {
      for (let col = 0; col < header.width; col += 1) {
        const value = cellAt(row, col);
        expect(Number.isFinite(value) && value >= header.minElev && value <= header.maxElev).toBe(
          true,
        );
      }
    }
  });

  it('covers the four bbox corners within one cell (frame.json agrees with local-frame.ts)', () => {
    const xMin = header.originX - header.cellSizeX;
    const xMax = header.originX + header.width * header.cellSizeX + header.cellSizeX;
    const yMax = header.originY + header.cellSizeY;
    const yMin = header.originY - header.height * header.cellSizeY - header.cellSizeY;
    for (const [lon, lat] of [
      [BBOX.west, BBOX.south],
      [BBOX.west, BBOX.north],
      [BBOX.east, BBOX.south],
      [BBOX.east, BBOX.north],
    ] as const) {
      const [x, y] = toLocal(lon, lat);
      expect(x >= xMin && x <= xMax && y >= yMin && y <= yMax).toBe(true);
    }
  });

  it('reproduces the committed bytes from the pinned TIFF', async () => {
    const frameBytes = readFileSync('data/frame.json');
    const tiff = readFileSync('data/raw/3dep.tif');
    const rebuilt = await buildTerrain(tiff, {
      frame: readFrame(frameBytes),
      frameSha256: sha256Hex(frameBytes),
      inputSha256: sha256Hex(tiff),
    });
    expect(Buffer.from(rebuilt.f32).equals(f32)).toBe(true);
    expect(renderHeaderJson(rebuilt.header)).toBe(readFileSync('data/terrain.json', 'utf8'));
  });

  it('has a replay record whose outputHash matches the files', () => {
    const replay = TerrainReplaySchema.parse(
      JSON.parse(readFileSync('data/terrain.replay.json', 'utf8')),
    );
    expect(replay.effect).toBe('preserves');
    expect(replay.outputHash).toBe(
      sha256Hex(Buffer.concat([f32, readFileSync('data/terrain.json')])),
    );
  });

  // Summit figure: PRIMARY, LiDAR-derived, recorded in data/probes/summit-max.json (scripts/probes/summit-max.mjs).
  // USGS 3DEP 1 m DEM, Minnesota DNR LiDAR acquired 2021-04-02, maximum over a 1 km window: 407.0683288574219 m at
  // 46.717165 N, 92.224042 W (EPSG:26915 559303.123 E, 5174026.808 N); USGS Elevation Point Query Service cross-check 406.97 m.
  // The 5 m resample may flatten the peak slightly, hence max within a radius and a 10 m tolerance.
  it('has a maximum within 10 m of 407.07 m inside 150 m of the LiDAR summit point', () => {
    const [cx, cy] = toLocal(-92.224042, 46.717165);
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (let row = 0; row < header.height; row += 1) {
      for (let col = 0; col < header.width; col += 1) {
        const x = header.originX + (col + 0.5) * header.cellSizeX;
        const y = header.originY - (row + 0.5) * header.cellSizeY;
        if (Math.hypot(x - cx, y - cy) <= 150) {
          count += 1;
          max = Math.max(max, cellAt(row, col));
        }
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(Math.abs(max - 407.07)).toBeLessThanOrEqual(10);
  });
});

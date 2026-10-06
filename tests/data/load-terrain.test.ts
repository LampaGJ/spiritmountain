import { describe, expect, it } from 'vitest';
import { loadTerrain, TerrainLoadError } from '../../src/data/load-terrain';
import {
  BIN_URL,
  FRAME_URL,
  HEADER_URL,
  SYN_COLS,
  SYN_ROWS,
  frameBytes,
  stubFetch,
  synBin,
  synFrame,
  synHeader,
  synValue,
} from './synthetic-terrain';

const urls = { headerUrl: HEADER_URL, binUrl: BIN_URL, frameUrl: FRAME_URL };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TerrainLoadError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('loadTerrain', () => {
  it('loads an 8 x 6 heightfield and maps the header corner origin to the first cell centre', async () => {
    const { header, heightfield } = await loadTerrain({ ...urls, fetchImpl: stubFetch() });
    expect(header.width).toBe(SYN_COLS);
    expect(heightfield.cols).toBe(SYN_COLS);
    expect(heightfield.rows).toBe(SYN_ROWS);
    expect(heightfield.originEast).toBe(-20 + 2.5);
    expect(heightfield.originNorth).toBe(15 - 2.5);
    expect(heightfield.cellSizeEast).toBe(5);
    expect(heightfield.cellSizeNorth).toBe(5);
    for (let r = 0; r < SYN_ROWS; r += 1) {
      for (let c = 0; c < SYN_COLS; c += 1) {
        expect(heightfield.data[r * SYN_COLS + c]).toBe(synValue(c, r));
      }
    }
  });

  it('reads little-endian bytes: 00 00 80 3f is 1.0, 00 00 20 41 is 10.0', async () => {
    const bin = synBin(() => 10);
    bin.set([0x00, 0x00, 0x80, 0x3f], 0);
    const header = { ...synHeader(), minElev: 1, maxElev: 10 };
    const { heightfield } = await loadTerrain({ ...urls, fetchImpl: stubFetch({ bin, header }) });
    expect(heightfield.data[0]).toBe(1);
    expect(heightfield.data[1]).toBe(10);
  });

  it('rejects a header with one renamed field (the instrument can fail)', async () => {
    const { width, ...rest } = synHeader();
    const renamed = { ...rest, cols: width };
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ header: renamed }) }))).toBe('HEADER_PARSE');
  });

  it('rejects a header whose width and height disagree with byteLength', async () => {
    const header = { ...synHeader(), width: SYN_COLS + 1 };
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ header }) }))).toBe('HEADER_PARSE');
  });

  it('rejects a binary whose byte length mismatches, naming both numbers', async () => {
    const bin = synBin().subarray(0, SYN_COLS * SYN_ROWS * 4 - 4);
    const promise = loadTerrain({ ...urls, fetchImpl: stubFetch({ bin }) });
    await expect(promise).rejects.toThrow(/BYTE_LENGTH.*188 bytes.*192/);
  });

  it('rejects a zero-length binary', async () => {
    const bin = new Uint8Array(0);
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ bin }) }))).toBe('EMPTY_BODY');
  });

  it('rejects a non-200 response for each of the three artifacts', async () => {
    for (const url of [HEADER_URL, BIN_URL, FRAME_URL]) {
      const fetchImpl = stubFetch({ status: { [url]: 500 } });
      expect(await codeOf(loadTerrain({ ...urls, fetchImpl }))).toBe('HTTP_STATUS');
    }
  });

  it('rejects a NaN value', async () => {
    const bin = synBin((c, r) => (c === 3 && r === 2 ? Number.NaN : synValue(c, r)));
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ bin }) }))).toBe('NON_FINITE');
  });

  it('rejects a value outside the header range (a nodata sentinel)', async () => {
    const bin = synBin((c, r) => (c === 3 && r === 2 ? -9999 : synValue(c, r)));
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ bin }) }))).toBe('OUT_OF_RANGE');
  });

  it('rejects a frame.json with a renamed field', async () => {
    const { epsg, ...rest } = synFrame();
    const frame = new TextEncoder().encode(JSON.stringify({ ...rest, crs: epsg }));
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ frame }) }))).toBe('FRAME_PARSE');
  });

  it('rejects a frame.json whose sha256 differs from the header record', async () => {
    const changed = { ...synFrame(), origin: { easting: 500001, northing: 5170000 } };
    const frame = new TextEncoder().encode(JSON.stringify(changed));
    expect(frame.length).not.toBe(0);
    expect(frameBytes()).not.toEqual(frame);
    expect(await codeOf(loadTerrain({ ...urls, fetchImpl: stubFetch({ frame }) }))).toBe('FRAME_HASH');
  });
});

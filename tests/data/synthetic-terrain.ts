import { createHash } from 'node:crypto';
import type { Frame } from '../../src/schema/frame';
import type { TerrainHeader } from '../../src/schema/terrain';

export const SYN_COLS = 8;
export const SYN_ROWS = 6;
export const HEADER_URL = 'mem://terrain.json';
export const BIN_URL = 'mem://terrain.f32';
export const FRAME_URL = 'mem://frame.json';

/** Deterministic ramp: 100 + 10 * col + 2 * row (metres). No randomness. */
export function synValue(col: number, row: number): number {
  return 100 + 10 * col + 2 * row;
}

export function synFrame(): Frame {
  return {
    version: 1,
    epsg: 26915,
    proj4Def: '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs',
    origin: { easting: 500000, northing: 5170000 },
    centre: { lon: -92.2, lat: 46.7 },
    bbox: { south: 46.68, west: -92.26, north: 46.74, east: -92.17 },
    axes: 'x east, y north, z elevation; metres; local = absolute UTM minus origin',
  };
}

export const frameBytes = (): Uint8Array => new TextEncoder().encode(JSON.stringify(synFrame()));
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function synHeader(): TerrainHeader {
  const values: number[] = [];
  for (let r = 0; r < SYN_ROWS; r += 1) for (let c = 0; c < SYN_COLS; c += 1) values.push(synValue(c, r));
  return {
    version: 1,
    width: SYN_COLS,
    height: SYN_ROWS,
    originX: -20,
    originY: 15,
    originCorner: 'top-left-of-top-left-pixel',
    cellSizeX: 5,
    cellSizeY: 5,
    rowOrder: 'north-to-south',
    columnOrder: 'west-to-east',
    byteOrder: 'LE',
    dtype: 'float32',
    byteLength: SYN_COLS * SYN_ROWS * 4,
    minElev: Math.min(...values),
    maxElev: Math.max(...values),
    plausibleRangeM: [150, 500],
    nodataValue: null,
    nodataRule: 'non-finite-only',
    fillMethod: 'chebyshev-bfs-fixed-order',
    nodataFilled: 0,
    frame: { file: 'data/frame.json', sha256: sha256(frameBytes()) },
    source: { path: 'data/raw/3dep.tif', sha256: 'a'.repeat(64) },
  };
}

/** Little-endian Float32 bytes, row-major, north row first, written with DataView so the layout is explicit. */
export function synBin(valueAt: (col: number, row: number) => number = synValue): Uint8Array {
  const bytes = new Uint8Array(SYN_COLS * SYN_ROWS * 4);
  const view = new DataView(bytes.buffer);
  for (let r = 0; r < SYN_ROWS; r += 1) {
    for (let c = 0; c < SYN_COLS; c += 1) view.setFloat32((r * SYN_COLS + c) * 4, valueAt(c, r), true);
  }
  return bytes;
}

export interface StubFiles {
  header?: unknown;
  bin?: Uint8Array;
  frame?: Uint8Array;
  status?: Partial<Record<string, number>>;
}

/** A fetch stub serving the three artifacts from memory. */
export function stubFetch(files: StubFiles = {}): typeof fetch {
  const bodies: Record<string, BodyInit> = {
    [HEADER_URL]: JSON.stringify(files.header ?? synHeader()),
    [BIN_URL]: (files.bin ?? synBin()) as BodyInit,
    [FRAME_URL]: (files.frame ?? frameBytes()) as BodyInit,
  };
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const status = files.status?.[url] ?? 200;
    const body = bodies[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(status === 200 ? body : 'error', { status });
  }) as typeof fetch;
}

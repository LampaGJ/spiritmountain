import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CanopyHeaderSchema, type CanopyHeader } from '../../src/schema/canopy';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/canopy.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/canopy.ts',
  'scripts/ingest/replay.ts',
  'src/schema/canopy.ts',
  'src/schema/replay.ts',
  'src/schema/terrain.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['zod'];

export const CANOPY_BIN_NAME = 'canopy.u8';
export const CANOPY_HEADER_NAME = 'canopy.json';
export const CANOPY_REPLAY_NAME = 'canopy.replay.json';

/** Summary cell edge, metres. */
export const CANOPY_CELL_M = 20;
/** Canopy height per byte step, metres. */
export const CANOPY_SCALE_M = 0.2;
/** Canopy height clamp, metres. */
export const CANOPY_MAX_M = 40;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Canopy replay schema
 * @strategicPurpose Extends the shared replay base with the lockfile subtree hash, so the canopy summary is provably reproducible from the pinned rasters.
 * @tacticalObjective Validates the base record (effect reduces) plus lockSubtreeSha256 before data/canopy.replay.json is written.
 */
export const CanopyReplaySchema = ReplayRecordSchema.extend({
  lockSubtreeSha256: Sha256Schema,
});
export type CanopyReplay = z.infer<typeof CanopyReplaySchema>;

export class CanopyError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

/** A decoded heightfield: row-major, north to south, west to east, plus its header. */
export interface Raster {
  header: TerrainHeader;
  data: Float32Array;
}

/** Decodes a little-endian float32 raster after checking its byte length against its header. */
export function decodeRaster(header: TerrainHeader, bytes: Uint8Array, what: string): Raster {
  if (bytes.byteLength !== header.byteLength) {
    throw new CanopyError(
      'BinLengthMismatch',
      `${what} is ${bytes.byteLength} bytes, header says ${header.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(header.width * header.height);
  for (let i = 0; i < data.length; i += 1) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) throw new CanopyError('NonFinite', `${what} cell ${i} is not finite`);
    data[i] = v;
  }
  return { header, data };
}

/** Bilinear height of a raster at a local-metre point; samples sit at cell centres, the edge is clamped. */
function bilinear(raster: Raster, east: number, north: number): number {
  const { header, data } = raster;
  const fx = Math.min(
    Math.max((east - header.originX) / header.cellSizeX - 0.5, 0),
    header.width - 1,
  );
  const fy = Math.min(
    Math.max((header.originY - north) / header.cellSizeY - 0.5, 0),
    header.height - 1,
  );
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, header.width - 1);
  const y1 = Math.min(y0 + 1, header.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number): number => data[y * header.width + x] as number;
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

export interface CanopyGrid {
  width: number;
  height: number;
  originX: number;
  originY: number;
  bytes: Uint8Array;
}

/**
 * @displayName Compute canopy height grid
 * @strategicPurpose Reduces the 4 m first-return raster to a 20 m canopy-height summary once at ingest, so the browser never needs the 18 MB raster for trail curtains.
 * @tacticalObjective For each first-return cell subtracts the bilinear bare-earth height at the cell centre, clamps to [0, CANOPY_MAX_M], takes the maximum over each CANOPY_CELL_M block (partial blocks at the south and east edges included), and quantises to one byte per CANOPY_SCALE_M with Math.round. The grid shares the first-return raster's top-left corner.
 * @manipulation reduces
 */
export function computeCanopyGrid(surface: Raster, terrain: Raster): CanopyGrid {
  const sh = surface.header;
  if (sh.cellSizeX !== sh.cellSizeY) {
    throw new CanopyError('CellNotSquare', `surface cell ${sh.cellSizeX} x ${sh.cellSizeY}`);
  }
  const block = CANOPY_CELL_M / sh.cellSizeX;
  if (!Number.isInteger(block) || block < 1) {
    throw new CanopyError(
      'CellNotDivisible',
      `${CANOPY_CELL_M} m is not a whole number of ${sh.cellSizeX} m cells`,
    );
  }
  const width = Math.ceil(sh.width / block);
  const height = Math.ceil(sh.height / block);
  const levels = new Uint8Array(width * height);
  for (let row = 0; row < sh.height; row += 1) {
    const north = sh.originY - (row + 0.5) * sh.cellSizeY;
    const gy = Math.floor(row / block);
    for (let col = 0; col < sh.width; col += 1) {
      const east = sh.originX + (col + 0.5) * sh.cellSizeX;
      const raw = (surface.data[row * sh.width + col] as number) - bilinear(terrain, east, north);
      const clamped = Math.min(Math.max(raw, 0), CANOPY_MAX_M);
      const level = Math.round(clamped / CANOPY_SCALE_M);
      const i = gy * width + Math.floor(col / block);
      if (level > (levels[i] as number)) levels[i] = level;
    }
  }
  return { width, height, originX: sh.originX, originY: sh.originY, bytes: levels };
}

function writeAtomic(path: string, content: string | Uint8Array): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

export interface CanopyOptions {
  dataDir: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

function readHeader(dataDir: string, name: string): { header: TerrainHeader; text: string } {
  const text = readFileSync(join(dataDir, name), 'utf8');
  const parsed = TerrainHeaderSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new CanopyError('HeaderInvalid', `${name}: ${parsed.error.message}`);
  return { header: parsed.data, text };
}

/** Reads the square first-return raster and the bare-earth terrain, computes the grid, then writes the bytes, the header and the replay sidecar last. */
export function runCanopy(options: CanopyOptions): { header: CanopyHeader; replay: CanopyReplay } {
  const { dataDir } = options;
  const surfaceHeader = readHeader(dataDir, 'surface/square.json');
  const terrainHeader = readHeader(dataDir, 'terrain.json');
  if (surfaceHeader.header.frame.sha256 !== terrainHeader.header.frame.sha256) {
    throw new CanopyError('FrameMismatch', 'surface and terrain headers name different frames');
  }
  const surfaceBytes = readFileSync(join(dataDir, 'surface/square.f32'));
  const terrainBytes = readFileSync(join(dataDir, 'terrain.f32'));
  const grid = computeCanopyGrid(
    decodeRaster(surfaceHeader.header, surfaceBytes, 'square.f32'),
    decodeRaster(terrainHeader.header, terrainBytes, 'terrain.f32'),
  );
  const sources = {
    surfaceHeader: { path: 'data/surface/square.json', sha256: sha256Hex(surfaceHeader.text) },
    surface: { path: 'data/surface/square.f32', sha256: sha256Hex(surfaceBytes) },
    terrainHeader: { path: 'data/terrain.json', sha256: sha256Hex(terrainHeader.text) },
    terrain: { path: 'data/terrain.f32', sha256: sha256Hex(terrainBytes) },
  };
  const candidate = {
    version: 1,
    width: grid.width,
    height: grid.height,
    originX: grid.originX,
    originY: grid.originY,
    originCorner: 'top-left-of-top-left-cell',
    cellSizeM: CANOPY_CELL_M,
    rowOrder: 'north-to-south',
    columnOrder: 'west-to-east',
    dtype: 'uint8',
    scaleM: CANOPY_SCALE_M,
    maxM: CANOPY_MAX_M,
    reduction: 'block-max',
    byteLength: grid.bytes.byteLength,
    u8Sha256: sha256Hex(grid.bytes),
    sources,
  };
  const gate = CanopyHeaderSchema.safeParse(candidate);
  if (!gate.success) throw new CanopyError('HeaderInvalid', gate.error.message);
  const header = gate.data;
  const headerText = `${JSON.stringify(header, null, 2)}\n`;
  const inputLines = Object.values(sources)
    .map((s) => `${s.path} ${s.sha256}\n`)
    .join('');
  const replayParsed = CanopyReplaySchema.safeParse({
    inputHash: sha256Hex(inputLines),
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(headerText),
    effect: 'reduces',
    lockSubtreeSha256: options.lockSubtree,
  });
  if (!replayParsed.success) throw new CanopyError('ReplayInvalid', replayParsed.error.message);
  const replay = replayParsed.data;
  mkdirSync(dataDir, { recursive: true });
  writeAtomic(join(dataDir, CANOPY_BIN_NAME), grid.bytes);
  writeAtomic(join(dataDir, CANOPY_HEADER_NAME), headerText);
  writeAtomic(join(dataDir, CANOPY_REPLAY_NAME), `${JSON.stringify(replay, null, 2)}\n`);
  return { header, replay };
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'allow-dirty': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  if (values.force !== true) {
    throw new CanopyError(
      'RefusedOverwrite',
      'ingest:canopy rewrites data/canopy.*; pass --force to run it',
    );
  }
  const started = performance.now();
  const { header } = runCanopy({
    dataDir: values['data-dir'] ?? 'data',
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () =>
      resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty: values['allow-dirty'] === true }),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `ingest:canopy ok ${header.width} x ${header.height} cells, ${header.byteLength} bytes, ${seconds} s\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

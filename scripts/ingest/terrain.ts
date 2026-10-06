import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import {
  LOCKFILE_URL,
  lockSubtreeSha256,
  readFrame,
  readThreeDepPin,
  resolveCodeCommit,
  sha256Hex,
  type Frame,
  type GridBbox,
  type ThreeDepPin,
} from './terrain-deps';

export type TerrainErrorCode =
  | 'PinnedInputHashMismatch'
  | 'ManifestDimensionMismatch'
  | 'ByteOrderMismatch'
  | 'ManifestStatsMismatch'
  | 'NoValidPixels'
  | 'NotPixelIsArea'
  | 'WrongCrs'
  | 'NotNorthUp'
  | 'RotatedRaster'
  | 'NonSquareCells'
  | 'BadRaster'
  | 'BadNodata'
  | 'ImplausibleElevation'
  | 'FillIncomplete'
  | 'EffectViolated'
  | 'HeaderInvalid';

/** A named, expected failure of the terrain transform. The CLI prints it and exits 1. */
export class TerrainError extends Error {
  readonly code: TerrainErrorCode;

  constructor(code: TerrainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TerrainError';
    this.code = code;
  }
}

/** Plausible elevation range in metres for the Spirit Mountain bbox; recorded in the header. A sanity bound, not surveyed. */
export const PLAUSIBLE_RANGE_M: readonly [number, number] = [150, 500];

/** Neighbour offsets as [dRow, dCol], visited in this fixed order; the first valid neighbour wins. */
export const FILL_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/terrain.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/terrain.ts',
  'scripts/ingest/terrain-deps.ts',
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/replay.ts',
  'src/schema/terrain.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay sidecar (lockSubtreeSha256). */
export const LOCK_ROOTS: string[] = ['geotiff', 'zod'];

const CELL_TOLERANCE = 0.005;

/**
 * @displayName Terrain heightfield file
 * @strategicPurpose Lets the browser read elevations as a typed array so TIFF is never parsed at runtime.
 * @tacticalObjective Row-major (north row first), little-endian Float32, width * height * 4 bytes, nodata already filled.
 */
export const TERRAIN_F32_NAME = 'terrain.f32';

/**
 * @displayName Terrain header file
 * @strategicPurpose Tells a reader exactly how to interpret terrain.f32 (size, origin corner, cell size, byte and row order, nodata handling) so nothing is guessed.
 * @tacticalObjective JSON document valid against TerrainHeaderSchema, keys in a fixed order, 2-space indent, trailing newline.
 */
export const TERRAIN_JSON_NAME = 'terrain.json';

/**
 * @displayName Terrain replay record file
 * @strategicPurpose Proves terrain.f32 and terrain.json are reproducible from the pinned TIFF and the committed transform code.
 * @tacticalObjective Holds inputHash, codeCommit, outputHash, effect preserves, per-file hashes and tool versions.
 */
export const TERRAIN_REPLAY_NAME = 'terrain.replay.json';

const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters (sha256)' });

/**
 * @displayName Terrain replay record
 * @strategicPurpose Extends the shared replay base with the per-file hashes and tool versions this transform adds.
 * @tacticalObjective Validates the base record plus outputs, toolVersions (the geotiff version only) and lockSubtreeSha256 before data/terrain.replay.json is written.
 */
export const TerrainReplaySchema = ReplayRecordSchema.extend({
  outputs: z.strictObject({ 'terrain.f32': Sha256Schema, 'terrain.json': Sha256Schema }),
  toolVersions: z.strictObject({ geotiff: z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
});
export type TerrainReplay = z.infer<typeof TerrainReplaySchema>;

export interface TerrainContext {
  frame: Frame;
  frameSha256: string;
  inputSha256: string;
}

export interface TerrainResult {
  f32: Uint8Array;
  header: TerrainHeader;
  /** Byte order of the input TIFF, from geotiff.js. */
  byteOrder: 'little' | 'big';
  /** Decoded raster extent in absolute EPSG:26915 metres. */
  bbox: GridBbox;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function at(values: readonly number[], index: number, label: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw new TerrainError('BadRaster', `${label} is missing or not finite`);
  }
  return value;
}

/**
 * Parses the raw GDAL_NODATA tag text. Does not assume a trailing NUL (geotiff.js getGDALNoData drops the last character unconditionally).
 * Returns null when there is no tag or the sentinel is NaN (non-finite pixels are always nodata).
 */
export function parseGdalNodata(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'string') throw new TerrainError('BadNodata', 'GDAL_NODATA tag is not text');
  // GDAL_NODATA is NUL-terminated ASCII; the NUL is written as the escape \x00, never a typed control character.
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\x00+$/, '').trim();
  if (text === '') throw new TerrainError('BadNodata', 'GDAL_NODATA tag is empty');
  if (text.toLowerCase() === 'nan') return null;
  const value = Number(text);
  if (!Number.isFinite(value))
    throw new TerrainError('BadNodata', `GDAL_NODATA tag is not a finite number: ${text}`);
  return value;
}

function neighbourIndexes(index: number, width: number, height: number): number[] {
  const row = Math.floor(index / width);
  const col = index - row * width;
  const found: number[] = [];
  for (const [dRow, dCol] of FILL_OFFSETS) {
    const r = row + dRow;
    const c = col + dCol;
    if (r >= 0 && r < height && c >= 0 && c < width) found.push(r * width + c);
  }
  return found;
}

/**
 * Fills nodata cells in place, ring by ring. Each round, every nodata cell with a valid 8-neighbour takes the value of its
 * first valid neighbour (fixed offset order), judged against the validity at the start of the round. `nodata` holds 1 for
 * cells to fill and is zeroed as cells are filled. Returns the number of cells filled.
 */
export function fillNodata(
  values: Float32Array,
  nodata: Uint8Array,
  width: number,
  height: number,
): number {
  const total = width * height;
  let remaining = 0;
  for (let i = 0; i < total; i += 1) {
    if (nodata[i] === 1) remaining += 1;
  }
  if (remaining === total)
    throw new TerrainError('NoValidPixels', 'every pixel is nodata, or the raster is empty');
  const queued = new Uint8Array(total);
  let frontier: number[] = [];
  for (let i = 0; i < total; i += 1) {
    if (nodata[i] === 1 && neighbourIndexes(i, width, height).some((q) => nodata[q] === 0)) {
      queued[i] = 1;
      frontier.push(i);
    }
  }
  let filled = 0;
  while (frontier.length > 0) {
    const assigned = new Float32Array(frontier.length);
    for (let k = 0; k < frontier.length; k += 1) {
      const index = frontier[k] as number;
      const source = neighbourIndexes(index, width, height).find((q) => nodata[q] === 0);
      if (source === undefined)
        throw new TerrainError('FillIncomplete', `cell ${index} has no valid neighbour`);
      assigned[k] = values[source] as number;
    }
    for (let k = 0; k < frontier.length; k += 1) {
      const index = frontier[k] as number;
      values[index] = assigned[k] as number;
      nodata[index] = 0;
      filled += 1;
    }
    const next: number[] = [];
    for (let k = 0; k < frontier.length; k += 1) {
      for (const q of neighbourIndexes(frontier[k] as number, width, height)) {
        if (nodata[q] === 1 && queued[q] === 0) {
          queued[q] = 1;
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  if (filled !== remaining)
    throw new TerrainError('FillIncomplete', `filled ${filled} of ${remaining} nodata cells`);
  return filled;
}

/**
 * @displayName Build terrain heightfield
 * @strategicPurpose Converts the pinned 3DEP GeoTIFF once into a typed-array heightfield in the shared local frame; pure so a rerun is byte-identical.
 * @tacticalObjective Decodes with geotiff.js, asserts raster conventions, fills nodata deterministically, and returns the little-endian Float32 bytes plus a validated header.
 */
export async function buildTerrain(
  tiffBytes: Uint8Array,
  ctx: TerrainContext,
): Promise<TerrainResult> {
  const arrayBuffer = tiffBytes.buffer.slice(
    tiffBytes.byteOffset,
    tiffBytes.byteOffset + tiffBytes.byteLength,
  ) as ArrayBuffer;
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const total = width * height;
  if (total < 1) throw new TerrainError('NoValidPixels', 'the raster has zero pixels');

  if (
    image.getSamplesPerPixel() !== 1 ||
    image.getSampleFormat() !== 3 ||
    image.getBitsPerSample() !== 32
  ) {
    throw new TerrainError('BadRaster', 'expected one band of 32-bit float samples');
  }
  const geoKeys = image.getGeoKeys();
  if (geoKeys?.ProjectedCSTypeGeoKey !== 26915) {
    throw new TerrainError(
      'WrongCrs',
      `ProjectedCSTypeGeoKey is ${String(geoKeys?.ProjectedCSTypeGeoKey)}, expected 26915`,
    );
  }
  if (!image.pixelIsArea()) {
    throw new TerrainError(
      'NotPixelIsArea',
      `GTRasterTypeGeoKey is ${String(geoKeys?.GTRasterTypeGeoKey)}, expected 1 (PixelIsArea)`,
    );
  }
  const directory = image.getFileDirectory();
  const transformation = directory.getValue('ModelTransformation') as unknown as
    number[] | undefined;
  if (transformation !== undefined && (transformation[1] !== 0 || transformation[4] !== 0)) {
    throw new TerrainError('RotatedRaster', 'ModelTransformation has rotation or shear');
  }
  const resolution = image.getResolution();
  if (!(at(resolution, 1, 'resolution y') < 0)) {
    throw new TerrainError(
      'NotNorthUp',
      'getResolution()[1] must be negative for a north-up raster',
    );
  }
  const box = image.getBoundingBox();
  const minX = at(box, 0, 'bbox minX');
  const minY = at(box, 1, 'bbox minY');
  const maxX = at(box, 2, 'bbox maxX');
  const maxY = at(box, 3, 'bbox maxY');
  const cellX = (maxX - minX) / width;
  const cellY = (maxY - minY) / height;
  if (!(cellX > 0) || !(cellY > 0) || Math.abs(cellX - cellY) > CELL_TOLERANCE * cellX) {
    throw new TerrainError(
      'NonSquareCells',
      `cell sizes ${cellX} and ${cellY} differ by more than ${CELL_TOLERANCE * 100} percent`,
    );
  }

  const sentinel = parseGdalNodata(
    directory.hasTag('GDAL_NODATA') ? directory.getValue('GDAL_NODATA') : undefined,
  );
  const sentinelF32 = sentinel === null ? null : Math.fround(sentinel);

  const rasters = await image.readRasters({ interleave: false });
  const band = (rasters as unknown as unknown[])[0];
  if (!(band instanceof Float32Array) || band.length !== total) {
    throw new TerrainError('BadRaster', 'sample 0 is not a Float32Array of width * height values');
  }
  const values = band;

  const mask = new Uint8Array(total);
  let validCount = 0;
  let implausible = 0;
  let validMin = Number.POSITIVE_INFINITY;
  let validMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < total; i += 1) {
    const value = values[i] as number;
    if (!Number.isFinite(value) || (sentinelF32 !== null && value === sentinelF32)) {
      mask[i] = 1;
      continue;
    }
    validCount += 1;
    if (value < validMin) validMin = value;
    if (value > validMax) validMax = value;
    if (value < PLAUSIBLE_RANGE_M[0] || value > PLAUSIBLE_RANGE_M[1]) implausible += 1;
  }
  if (validCount === 0) throw new TerrainError('NoValidPixels', 'every pixel is nodata');
  if (implausible > 0) {
    throw new TerrainError(
      'ImplausibleElevation',
      `${implausible} valid pixels outside ${PLAUSIBLE_RANGE_M[0]}..${PLAUSIBLE_RANGE_M[1]} m (observed min ${validMin}, max ${validMax})`,
    );
  }

  const nodataFilled = fillNodata(values, mask, width, height);

  let minElev = Number.POSITIVE_INFINITY; // Math.fround values, so min and max equal exact Float32 cells
  let maxElev = Number.NEGATIVE_INFINITY;
  const f32 = new Uint8Array(total * 4);
  const view = new DataView(f32.buffer);
  for (let i = 0; i < total; i += 1) {
    const value = Math.fround(values[i] as number);
    if (value < minElev) minElev = value;
    if (value > maxElev) maxElev = value;
    view.setFloat32(i * 4, value, true);
  }
  if (f32.byteLength !== total * 4 || values.length !== total) {
    throw new TerrainError('EffectViolated', 'output pixel count differs from input pixel count');
  }

  const candidate = {
    version: 1,
    width,
    height,
    originX: round6(minX - ctx.frame.originE),
    originY: round6(maxY - ctx.frame.originN),
    originCorner: 'top-left-of-top-left-pixel',
    cellSizeX: round6(cellX),
    cellSizeY: round6(cellY),
    rowOrder: 'north-to-south',
    columnOrder: 'west-to-east',
    byteOrder: 'LE',
    dtype: 'float32',
    byteLength: f32.byteLength,
    minElev, // already Math.fround (exact Float32); not rounded
    maxElev,
    plausibleRangeM: [PLAUSIBLE_RANGE_M[0], PLAUSIBLE_RANGE_M[1]],
    nodataValue: sentinel,
    nodataRule: sentinel === null ? 'non-finite-only' : 'gdal-nodata-tag-or-non-finite',
    fillMethod: 'chebyshev-bfs-fixed-order',
    nodataFilled,
    frame: { file: 'data/frame.json', sha256: ctx.frameSha256 },
    source: { path: 'data/raw/3dep.tif', sha256: ctx.inputSha256 },
  };
  const checked = TerrainHeaderSchema.safeParse(candidate);
  if (!checked.success) throw new TerrainError('HeaderInvalid', checked.error.message);
  return {
    f32,
    header: candidate as TerrainHeader,
    byteOrder: tiff.littleEndian ? 'little' : 'big',
    bbox: { xmin: minX, ymin: minY, xmax: maxX, ymax: maxY },
  };
}

/** Serializes the header with keys in the fixed construction order, 2-space indent and a trailing newline. */
export function renderHeaderJson(header: TerrainHeader): string {
  return `${JSON.stringify(header, null, 2)}\n`;
}

export interface RunOptions {
  dataDir: string;
  pin: ThreeDepPin;
  frame: Frame;
  frameSha256: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

const PackageSchema = z.looseObject({ dependencies: z.record(z.string(), z.string()) });

function geotiffVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const version = PackageSchema.parse(JSON.parse(text)).dependencies['geotiff'];
  if (version === undefined)
    throw new TerrainError('BadRaster', 'package.json has no geotiff dependency');
  return version;
}

/** Reads the pinned TIFF, verifies it against the manifest pin, builds, validates, and writes the three artifacts atomically (replay last). */
export async function runTerrain(
  options: RunOptions,
): Promise<{ header: TerrainHeader; replay: TerrainReplay }> {
  const { pin } = options;
  const tiff = readFileSync(join(options.dataDir, 'raw', '3dep.tif'));
  const inputSha256 = sha256Hex(tiff);
  if (inputSha256 !== pin.sha256) {
    throw new TerrainError(
      'PinnedInputHashMismatch',
      `3dep.tif sha256 ${inputSha256} differs from the manifest pin ${pin.sha256}`,
    );
  }
  const built = await buildTerrain(tiff, {
    frame: options.frame,
    frameSha256: options.frameSha256,
    inputSha256,
  });
  const { f32, header } = built;
  if (header.width !== pin.width || header.height !== pin.height) {
    throw new TerrainError(
      'ManifestDimensionMismatch',
      `TIFF is ${header.width}x${header.height}, manifest says ${pin.width}x${pin.height}`,
    );
  }
  for (const key of ['xmin', 'ymin', 'xmax', 'ymax'] as const) {
    if (Math.abs(built.bbox[key] - pin.bbox[key]) > 1e-6) {
      throw new TerrainError(
        'ManifestDimensionMismatch',
        `decoded bbox ${key} ${built.bbox[key]} differs from manifest ${pin.bbox[key]}`,
      );
    }
  }
  if (built.byteOrder !== pin.byteOrder) {
    throw new TerrainError(
      'ByteOrderMismatch',
      `TIFF is ${built.byteOrder}-endian, manifest says ${pin.byteOrder}`,
    );
  }
  if (
    header.nodataFilled === 0 &&
    (Math.abs(header.minElev - pin.stats.min) > 1e-3 ||
      Math.abs(header.maxElev - pin.stats.max) > 1e-3)
  ) {
    throw new TerrainError(
      'ManifestStatsMismatch',
      `range ${header.minElev}..${header.maxElev} differs from manifest ${pin.stats.min}..${pin.stats.max}`,
    );
  }
  const jsonBytes = Buffer.from(renderHeaderJson(header), 'utf8');
  const replayCandidate = {
    inputHash: inputSha256,
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(Buffer.concat([f32, jsonBytes])),
    effect: 'preserves',
    outputs: { 'terrain.f32': sha256Hex(f32), 'terrain.json': sha256Hex(jsonBytes) },
    toolVersions: { geotiff: geotiffVersion() },
    lockSubtreeSha256: options.lockSubtree,
  };
  const replay = TerrainReplaySchema.parse(replayCandidate);
  mkdirSync(options.dataDir, { recursive: true });
  writeAtomic(join(options.dataDir, TERRAIN_F32_NAME), f32);
  writeAtomic(join(options.dataDir, TERRAIN_JSON_NAME), jsonBytes);
  writeAtomic(
    join(options.dataDir, TERRAIN_REPLAY_NAME),
    Buffer.from(`${JSON.stringify(replayCandidate, null, 2)}\n`, 'utf8'),
  );
  return { header, replay };
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'allow-dirty': { type: 'boolean', default: false },
    },
  });
  const dataDir = values['data-dir'] ?? 'data';
  const allowDirty = values['allow-dirty'] === true;
  const pin = readThreeDepPin(readFileSync(join(dataDir, 'raw', 'manifest.json')));
  const frameBytes = readFileSync(join(dataDir, 'frame.json'));
  const result = await runTerrain({
    dataDir,
    pin,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty }),
  });
  process.stdout.write(
    `ingest:terrain ok ${result.header.width}x${result.header.height} nodataFilled=${result.header.nodataFilled}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

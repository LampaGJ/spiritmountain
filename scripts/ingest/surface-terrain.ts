import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fromArrayBuffer } from 'geotiff';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import { SurfaceManifestSchema } from './surface-manifest-schema';
import {
  LOCKFILE_URL,
  lockSubtreeSha256,
  readFrame,
  resolveCodeCommit,
  sha256Hex,
  type Frame,
} from './terrain-deps';
import {
  PLAUSIBLE_RANGE_M,
  TerrainError,
  fillNodata,
  parseGdalNodata,
  renderHeaderJson,
} from './terrain';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/surface-terrain.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/replay.ts',
  'scripts/ingest/surface-manifest-schema.ts',
  'scripts/ingest/surface-terrain.ts',
  'scripts/ingest/terrain-deps.ts',
  'scripts/ingest/terrain.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
  'src/schema/terrain.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['geotiff', 'zod'];

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Surface heightfield file
 * @strategicPurpose Lets the browser read first-return elevations (roofs and canopy) as a typed array, so the TIFF is never parsed at runtime.
 * @tacticalObjective Row-major (north row first), little-endian Float32, width * height * 4 bytes, nodata already filled by nearest valid neighbour.
 */
export const SURFACE_F32_NAME = 'core.f32';

/**
 * @displayName Surface header file
 * @strategicPurpose Tells a reader exactly how to interpret core.f32 (window origin in the shared local frame, cell size, orders, fill count) so the surface can be aligned to the bare-earth grid without guessing.
 * @tacticalObjective JSON document valid against TerrainHeaderSchema, source.path data/raw/surface-core.tif, fixed key order, 2-space indent, trailing newline.
 */
export const SURFACE_JSON_NAME = 'core.json';

/**
 * @displayName Surface replay record
 * @strategicPurpose Proves core.f32 and core.json are reproducible from the pinned surface TIFF and the committed transform code.
 * @tacticalObjective Holds inputHash, codeCommit, outputHash, effect preserves, per-file hashes, the geotiff version and the lockfile subtree hash.
 */
export const SURFACE_REPLAY_NAME = 'surface.replay.json';

/**
 * @displayName Surface replay schema
 * @strategicPurpose Extends the shared replay base with the per-file hashes and tool versions this transform adds.
 * @tacticalObjective Validates the base record plus outputs, toolVersions (geotiff only) and lockSubtreeSha256 before data/surface/surface.replay.json is written.
 */
export const SurfaceReplaySchema = ReplayRecordSchema.extend({
  outputs: z.strictObject({ [SURFACE_F32_NAME]: Sha256Schema, [SURFACE_JSON_NAME]: Sha256Schema }),
  toolVersions: z.strictObject({ geotiff: z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
  // The header's strict source block cannot carry these, so the record does.
  decodeResolutionM: z.literal(2),
  pooling: z.literal('max'),
});
export type SurfaceReplay = z.infer<typeof SurfaceReplaySchema>;

/** Output cell size in metres: the pinned 1 m raster is max-pooled 2x2. */
export const DECODE_RESOLUTION_M = 2;

/**
 * Max-pools 2x2 blocks of a row-major raster. Nodata-aware: the output is the max over the valid cells of the block;
 * a block with no valid cell is nodata (mask 1, value 0) for the nearest-valid fill. Width and height must be even.
 */
export function maxPool2(
  values: Float32Array,
  nodata: Uint8Array,
  width: number,
  height: number,
): { values: Float32Array; nodata: Uint8Array; width: number; height: number } {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new TerrainError('BadRaster', `cannot 2x2 pool a ${width}x${height} raster`);
  }
  const w = width / 2;
  const h = height / 2;
  const out = new Float32Array(w * h);
  const mask = new Uint8Array(w * h).fill(1);
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) {
      let best = Number.NEGATIVE_INFINITY;
      for (const [dr, dc] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ] as const) {
        const i = (2 * r + dr) * width + 2 * c + dc;
        if (nodata[i] === 0 && (values[i] as number) > best) best = values[i] as number;
      }
      if (best !== Number.NEGATIVE_INFINITY) {
        out[r * w + c] = best;
        mask[r * w + c] = 0;
      }
    }
  }
  return { values: out, nodata: mask, width: w, height: h };
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Decodes the 1 m surface TIFF, max-pools it to 2 m, fills the remaining nodata, and returns the Float32 bytes and a validated header.
 * Same raster conventions as buildTerrain (EPSG:26915, PixelIsArea, north-up, one float32 band, nodata tag), checked here because
 * buildTerrain fills before it can pool.
 */
export async function buildSurface(
  tiffBytes: Uint8Array,
  ctx: { frame: Frame; frameSha256: string; inputSha256: string; sourcePath: string },
): Promise<{
  f32: Uint8Array;
  header: TerrainHeader;
  bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
}> {
  const arrayBuffer = tiffBytes.buffer.slice(
    tiffBytes.byteOffset,
    tiffBytes.byteOffset + tiffBytes.byteLength,
  ) as ArrayBuffer;
  const image = await (await fromArrayBuffer(arrayBuffer)).getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (
    image.getSamplesPerPixel() !== 1 ||
    image.getSampleFormat() !== 3 ||
    image.getBitsPerSample() !== 32
  ) {
    throw new TerrainError('BadRaster', 'expected one band of 32-bit float samples');
  }
  const crs = image.getGeoKeys()?.ProjectedCSTypeGeoKey;
  if (crs !== 26915)
    throw new TerrainError('WrongCrs', `ProjectedCSTypeGeoKey is ${String(crs)}, expected 26915`);
  if (!image.pixelIsArea()) throw new TerrainError('NotPixelIsArea', 'expected PixelIsArea');
  const [xmin, ymin, xmax, ymax] = image.getBoundingBox() as [number, number, number, number];
  if (Math.abs((xmax - xmin) / width - 1) > 1e-6 || Math.abs((ymax - ymin) / height - 1) > 1e-6) {
    throw new TerrainError('NonSquareCells', 'expected 1 m square cells');
  }
  const directory = image.getFileDirectory();
  const sentinel = parseGdalNodata(
    directory.hasTag('GDAL_NODATA') ? directory.getValue('GDAL_NODATA') : undefined,
  );
  const sentinelF32 = sentinel === null ? null : Math.fround(sentinel);
  const band = ((await image.readRasters({ interleave: false })) as unknown as unknown[])[0];
  if (!(band instanceof Float32Array) || band.length !== width * height) {
    throw new TerrainError('BadRaster', 'sample 0 is not a Float32Array of width * height values');
  }
  const mask = new Uint8Array(band.length);
  for (let i = 0; i < band.length; i += 1) {
    const v = band[i] as number;
    // Spurious returns (birds, wires, noise) sit outside the plausible range; they are nodata, not a failure, because a
    // first-return surface always has some and a max-pool would otherwise spread them. They are counted in nodataFilled.
    if (
      !Number.isFinite(v) ||
      (sentinelF32 !== null && v === sentinelF32) ||
      v < PLAUSIBLE_RANGE_M[0] ||
      v > PLAUSIBLE_RANGE_M[1]
    )
      mask[i] = 1;
  }
  const pooled = maxPool2(band, mask, width, height);
  const nodataFilled = fillNodata(pooled.values, pooled.nodata, pooled.width, pooled.height);
  const total = pooled.width * pooled.height;
  const f32 = new Uint8Array(total * 4);
  const view = new DataView(f32.buffer);
  let minElev = Number.POSITIVE_INFINITY;
  let maxElev = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < total; i += 1) {
    const v = Math.fround(pooled.values[i] as number);
    if (v < minElev) minElev = v;
    if (v > maxElev) maxElev = v;
    view.setFloat32(i * 4, v, true);
  }
  const checked = TerrainHeaderSchema.safeParse({
    version: 1,
    width: pooled.width,
    height: pooled.height,
    originX: round6(xmin - ctx.frame.originE),
    originY: round6(ymax - ctx.frame.originN),
    originCorner: 'top-left-of-top-left-pixel',
    cellSizeX: DECODE_RESOLUTION_M,
    cellSizeY: DECODE_RESOLUTION_M,
    rowOrder: 'north-to-south',
    columnOrder: 'west-to-east',
    byteOrder: 'LE',
    dtype: 'float32',
    byteLength: f32.byteLength,
    minElev,
    maxElev,
    plausibleRangeM: [PLAUSIBLE_RANGE_M[0], PLAUSIBLE_RANGE_M[1]],
    nodataValue: sentinel,
    nodataRule: sentinel === null ? 'non-finite-only' : 'gdal-nodata-tag-or-non-finite',
    fillMethod: 'chebyshev-bfs-fixed-order',
    nodataFilled,
    frame: { file: 'data/frame.json', sha256: ctx.frameSha256 },
    source: { path: ctx.sourcePath, sha256: ctx.inputSha256 },
  });
  if (!checked.success) throw new TerrainError('HeaderInvalid', checked.error.message);
  return { f32, header: checked.data, bbox: { xmin, ymin, xmax, ymax } };
}

const PackageSchema = z.looseObject({ dependencies: z.record(z.string(), z.string()) });

function geotiffVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const version = PackageSchema.parse(JSON.parse(text)).dependencies['geotiff'];
  if (version === undefined)
    throw new TerrainError('BadRaster', 'package.json has no geotiff dependency');
  return version;
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

export interface SurfaceTerrainOptions {
  dataDir: string;
  frame: Frame;
  frameSha256: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

/**
 * @displayName Build surface heightfield
 * @strategicPurpose Converts the pinned 1 m first-return TIFF once into a 2 m typed-array heightfield (max over each 2x2 block, so roofs and canopy keep their peaks) in the shared local frame, with the same decode, nodata and header rules as the bare-earth terrain; pure so a rerun is byte-identical.
 * @tacticalObjective Verifies the TIFF against the surface manifest sha256, size and window, max-pools it 2x2 to 2 m cells, fills remaining nodata, and writes data/surface/core.f32, core.json, then surface.replay.json last.
 */
export async function runSurfaceTerrain(
  options: SurfaceTerrainOptions,
): Promise<{ header: TerrainHeader; replay: SurfaceReplay }> {
  const manifest = SurfaceManifestSchema.parse(
    JSON.parse(readFileSync(join(options.dataDir, 'raw', 'surface-manifest.json'), 'utf8')),
  );
  const tiff = readFileSync(join(options.dataDir, 'raw', 'surface-core.tif'));
  const inputSha256 = sha256Hex(tiff);
  if (inputSha256 !== manifest.sha256) {
    throw new TerrainError(
      'PinnedInputHashMismatch',
      `surface-core.tif sha256 ${inputSha256} differs from the manifest pin ${manifest.sha256}`,
    );
  }
  const built = await buildSurface(tiff, {
    frame: options.frame,
    frameSha256: options.frameSha256,
    inputSha256,
    sourcePath: manifest.path,
  });
  if (
    built.header.width * DECODE_RESOLUTION_M !== manifest.width * manifest.resolutionM ||
    built.header.height * DECODE_RESOLUTION_M !== manifest.height * manifest.resolutionM
  ) {
    throw new TerrainError(
      'ManifestDimensionMismatch',
      `decoded ${built.header.width}x${built.header.height} cells of ${DECODE_RESOLUTION_M} m differs from manifest ${manifest.width}x${manifest.height} cells of ${manifest.resolutionM} m`,
    );
  }
  for (const side of ['xmin', 'ymin', 'xmax', 'ymax'] as const) {
    if (Math.abs(built.bbox[side] - manifest.window26915[side]) > 1e-6) {
      throw new TerrainError(
        'ManifestDimensionMismatch',
        `decoded bbox ${side} ${built.bbox[side]} differs from manifest ${manifest.window26915[side]}`,
      );
    }
  }
  const checked = TerrainHeaderSchema.safeParse({
    ...built.header,
    source: { path: manifest.path, sha256: inputSha256 },
  });
  if (!checked.success) throw new TerrainError('HeaderInvalid', checked.error.message);
  const header = checked.data;
  const jsonBytes = Buffer.from(renderHeaderJson(header), 'utf8');
  const replayCandidate = {
    inputHash: inputSha256,
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(Buffer.concat([built.f32, jsonBytes])),
    effect: 'preserves',
    outputs: {
      [SURFACE_F32_NAME]: sha256Hex(built.f32),
      [SURFACE_JSON_NAME]: sha256Hex(jsonBytes),
    },
    toolVersions: { geotiff: geotiffVersion() },
    lockSubtreeSha256: options.lockSubtree,
    decodeResolutionM: DECODE_RESOLUTION_M,
    pooling: 'max',
  };
  const replay = SurfaceReplaySchema.parse(replayCandidate);
  const outDir = join(options.dataDir, 'surface');
  mkdirSync(outDir, { recursive: true });
  writeAtomic(join(outDir, SURFACE_F32_NAME), built.f32);
  writeAtomic(join(outDir, SURFACE_JSON_NAME), jsonBytes);
  writeAtomic(
    join(outDir, SURFACE_REPLAY_NAME),
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
  const frameBytes = readFileSync(join(dataDir, 'frame.json'));
  const { header } = await runSurfaceTerrain({
    dataDir,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty }),
  });
  process.stdout.write(
    `ingest:surface-terrain ok ${header.width}x${header.height} elev ${header.minElev}..${header.maxElev} nodataFilled=${header.nodataFilled}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fromArrayBuffer } from 'geotiff';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import {
  CANOPY_CAP_M,
  SPIKE_K,
  SPIKE_MIN_M,
  SPIKE_SUPPORT,
  SPIKE_SUPPORT_TOL_M,
  SPIKE_SUPPORT_WIDE,
  SPIKE_WINDOW,
  despike,
  type GroundSampler,
} from './despike';
import { SurfaceManifestSchema } from './surface-manifest-schema';
import { seamEastingAtNorthing } from './surface-window';
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
  'scripts/ingest/despike.ts',
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/replay.ts',
  'scripts/ingest/surface-manifest-schema.ts',
  'scripts/ingest/surface-terrain.ts',
  'scripts/ingest/surface-window.ts',
  'scripts/ingest/local-frame.ts',
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
  outputs: z.record(z.string(), Sha256Schema),
  toolVersions: z.strictObject({ geotiff: z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
  // The header's strict source block cannot carry these, so the record does.
  decodeResolutionM: z.union([z.literal(2), z.literal(4)]),
  pooling: z.literal('max'),
  /** Square window only: fraction of seam-column cells with a valid return before the fill. */
  seamValidFraction: z.number().min(0).max(1).optional(),
  /** Square window only: mean valid fraction of the columns 4 to 12 cells either side of the seam, the stripe gate's baseline. */
  neighbourValidFraction: z.number().min(0).max(1).optional(),
  /** The isolated-spike filter: per-pass counts and largest removed delta, and the max elevation before and after. */
  despike: z.strictObject({
    window: z.number().int().positive(),
    passes: z.array(
      z.strictObject({ spikesRemoved: z.number().int().min(0), maxDelta: z.number().min(0) }),
    ),
    /** Cells clamped by the bare-earth ceiling (ground + canopyCapM); includes any legitimate tall structure. */
    cappedToCanopy: z.number().int().min(0),
    maxExcessM: z.number().min(0),
    maxBefore: z.number(),
    maxAfter: z.number(),
    constants: z.strictObject({
      spikeMinM: z.number(),
      spikeK: z.number(),
      spikeSupport: z.number().int(),
      spikeSupportTolM: z.number(),
      spikeSupportWide: z.number().int(),
      canopyCapM: z.number(),
    }),
  }),
  /** sha256 of data/terrain.f32 + data/terrain.json, the bare-earth heightfield the canopy cap samples; a second input to the replay. */
  groundSha256: Sha256Schema,
});
export type SurfaceReplay = z.infer<typeof SurfaceReplaySchema>;

/** The bare-earth heightfield the canopy cap samples (5 m cells, same local frame). */
export const GROUND_F32_NAME = 'terrain.f32';
export const GROUND_JSON_NAME = 'terrain.json';

/** Bare-earth heightfield: its header and Float32 samples, north row first. */
export interface Ground {
  header: TerrainHeader;
  values: Float32Array;
  sha256: string;
}

/** Reads and checks data/terrain.f32 + terrain.json (byteLength against the header), hashing both. */
export function loadGround(dataDir: string): Ground {
  const jsonBytes = readFileSync(join(dataDir, GROUND_JSON_NAME));
  const f32 = readFileSync(join(dataDir, GROUND_F32_NAME));
  const parsed = TerrainHeaderSchema.safeParse(JSON.parse(jsonBytes.toString('utf8')));
  if (!parsed.success) throw new TerrainError('HeaderInvalid', parsed.error.message);
  const header = parsed.data;
  if (f32.byteLength !== header.byteLength || f32.byteLength !== header.width * header.height * 4) {
    throw new TerrainError(
      'ManifestDimensionMismatch',
      `${GROUND_F32_NAME} is ${f32.byteLength} bytes, header says ${header.byteLength}`,
    );
  }
  const values = new Float32Array(header.width * header.height);
  const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getFloat32(i * 4, true);
  return { header, values, sha256: sha256Hex(Buffer.concat([f32, jsonBytes])) };
}

/**
 * Bilinear sampler of the bare-earth grid at the centre of each cell of a surface grid in the same local frame.
 * Null where the surface cell centre lies outside the bare-earth grid's cell-centre extent (no ground known, so no cap).
 */
export function groundSampler(
  ground: Ground,
  surface: { originX: number; originY: number; cellM: number },
): GroundSampler {
  const { header, values } = ground;
  return (row, col) => {
    const x = surface.originX + (col + 0.5) * surface.cellM;
    const y = surface.originY - (row + 0.5) * surface.cellM;
    const fc = (x - header.originX) / header.cellSizeX - 0.5;
    const fr = (header.originY - y) / header.cellSizeY - 0.5;
    if (fc < 0 || fr < 0 || fc > header.width - 1 || fr > header.height - 1) return null;
    const c0 = Math.min(Math.floor(fc), header.width - 2 < 0 ? 0 : header.width - 2);
    const r0 = Math.min(Math.floor(fr), header.height - 2 < 0 ? 0 : header.height - 2);
    const tc = fc - c0;
    const tr = fr - r0;
    const c1 = Math.min(c0 + 1, header.width - 1);
    const r1 = Math.min(r0 + 1, header.height - 1);
    const at = (r: number, c: number): number => values[r * header.width + c] as number;
    const top = at(r0, c0) * (1 - tc) + at(r0, c1) * tc;
    const bottom = at(r1, c0) * (1 - tc) + at(r1, c1) * tc;
    return top * (1 - tr) + bottom * tr;
  };
}

export const SURFACE_WINDOWS = ['core', 'square'] as const;
export type SurfaceWindowName = (typeof SURFACE_WINDOWS)[number];

/** Minimum valid fraction of the cells on the dataset seam, before the fill, for the square window. */
export const SEAM_MIN_VALID_FRACTION = 0.9;
/**
 * The seam also passes when it is no emptier than its neighbours by more than this. Lidar returns nothing from water, so
 * the real data has voids (about 20 percent east of the resort) that are not a stripe; a stripe is a drop at the seam.
 */
export const SEAM_MAX_DROP = 0.05;

/** Per-window file names and output cell size (the pinned raster is max-pooled to it, 2x2). */
export const WINDOW_CONFIG = {
  core: {
    manifest: 'surface-manifest.json',
    tif: 'surface-core.tif',
    f32: 'core.f32',
    json: 'core.json',
    replay: 'surface.replay.json',
    cellM: 2,
    checkSeam: false,
  },
  square: {
    manifest: 'surface-square-manifest.json',
    tif: 'surface-square.tif',
    f32: 'square.f32',
    json: 'square.json',
    replay: 'square.replay.json',
    cellM: 4,
    checkSeam: true,
  },
} as const;

/**
 * Max-pools 2x2 blocks of a row-major raster. Nodata-aware: the output is the max over the valid cells of the block;
 * a block with no valid cell is nodata (mask 1, value 0) for the nearest-valid fill. An odd width or height gives a
 * clipped last block, so the output is ceil(width / 2) by ceil(height / 2).
 */
export function maxPool2(
  values: Float32Array,
  nodata: Uint8Array,
  width: number,
  height: number,
): { values: Float32Array; nodata: Uint8Array; width: number; height: number } {
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
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
        if (2 * r + dr >= height || 2 * c + dc >= width) continue;
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
  ctx: {
    frame: Frame;
    frameSha256: string;
    inputSha256: string;
    sourcePath: string;
    /** Output cell size in metres; the input must be this or half of it. */
    cellM: number;
    /** Measure the valid fraction on the EPT dataset seam before the fill. */
    checkSeam: boolean;
    /** The bare-earth heightfield for the canopy cap. */
    ground: Ground;
  },
): Promise<{
  f32: Uint8Array;
  header: TerrainHeader;
  bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** Valid fraction of the seam-column cells before the fill; null unless ctx.checkSeam. */
  seamValidFraction: number | null;
  /** Mean valid fraction of the columns 4, 8 and 12 cells either side of the seam; null unless ctx.checkSeam. */
  neighbourValidFraction: number | null;
  /** The isolated-spike filter's counts, applied after pooling and before the nodata fill. */
  despike: SurfaceReplay['despike'];
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
  const inCellM = (xmax - xmin) / width;
  if (Math.abs((ymax - ymin) / height - inCellM) > 1e-6) {
    throw new TerrainError('NonSquareCells', 'expected square cells');
  }
  const factor = Math.round(ctx.cellM / inCellM);
  if (Math.abs(ctx.cellM / inCellM - factor) > 1e-6 || (factor !== 1 && factor !== 2)) {
    throw new TerrainError(
      'NonSquareCells',
      `input cells of ${inCellM} m cannot be pooled to ${ctx.cellM} m by a factor of 1 or 2`,
    );
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
  const pooled =
    factor === 2
      ? maxPool2(band, mask, width, height)
      : { values: band, nodata: mask, width, height };
  let seamValidFraction: number | null = null;
  let neighbourValidFraction: number | null = null;
  if (ctx.checkSeam) {
    /** Valid fraction of the cells offset columns east of the seam line, row by row, before the fill. */
    const validAt = (offset: number): number | null => {
      let valid = 0;
      let counted = 0;
      for (let r = 0; r < pooled.height; r += 1) {
        const northing = ymax - (r + 0.5) * ctx.cellM;
        const col = Math.floor((seamEastingAtNorthing(northing) - xmin) / ctx.cellM) + offset;
        if (col < 0 || col >= pooled.width) continue;
        counted += 1;
        if (pooled.nodata[r * pooled.width + col] === 0) valid += 1;
      }
      return counted === 0 ? null : valid / counted;
    };
    seamValidFraction = validAt(0);
    if (seamValidFraction === null)
      throw new TerrainError('BadRaster', 'the dataset seam is outside the raster');
    const around = [-12, -8, -4, 4, 8, 12].map(validAt).filter((x): x is number => x !== null);
    neighbourValidFraction =
      around.length === 0 ? seamValidFraction : around.reduce((p, q) => p + q, 0) / around.length;
  }
  const despiked = despike(pooled.values, pooled.width, pooled.height, pooled.nodata, {
    ground: groundSampler(ctx.ground, {
      originX: round6(xmin - ctx.frame.originE),
      originY: round6(ymax - ctx.frame.originN),
      cellM: ctx.cellM,
    }),
  });
  pooled.values.set(despiked.data);
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
    cellSizeX: ctx.cellM,
    cellSizeY: ctx.cellM,
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
  return {
    f32,
    header: checked.data,
    bbox: { xmin, ymin, xmax, ymax },
    seamValidFraction,
    neighbourValidFraction,
    despike: {
      window: SPIKE_WINDOW,
      passes: despiked.passes,
      cappedToCanopy: despiked.cappedToCanopy,
      maxExcessM: despiked.maxExcessM,
      maxBefore: despiked.maxBefore,
      maxAfter: despiked.maxAfter,
      constants: {
        spikeMinM: SPIKE_MIN_M,
        spikeK: SPIKE_K,
        spikeSupport: SPIKE_SUPPORT,
        spikeSupportTolM: SPIKE_SUPPORT_TOL_M,
        spikeSupportWide: SPIKE_SUPPORT_WIDE,
        canopyCapM: CANOPY_CAP_M,
      },
    },
  };
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
  /** Which pinned raster to decode; default core. */
  window?: SurfaceWindowName;
  frame: Frame;
  frameSha256: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

/**
 * @displayName Build surface heightfield
 * @strategicPurpose Converts the pinned 1 m first-return TIFF once into a 2 m typed-array heightfield (max over each 2x2 block, so roofs and canopy keep their peaks) in the shared local frame, with the same decode, nodata and header rules as the bare-earth terrain; pure so a rerun is byte-identical.
 * @tacticalObjective Verifies the TIFF against the surface manifest sha256, size and window, max-pools it 2x2 to 2 m cells, removes isolated spikes and clamps cells above bare-earth + CANOPY_CAP_M, fills remaining nodata, and writes data/surface/core.f32, core.json, then surface.replay.json last.
 */
export async function runSurfaceTerrain(
  options: SurfaceTerrainOptions,
): Promise<{ header: TerrainHeader; replay: SurfaceReplay }> {
  const config = WINDOW_CONFIG[options.window ?? 'core'];
  const manifest = SurfaceManifestSchema.parse(
    JSON.parse(readFileSync(join(options.dataDir, 'raw', config.manifest), 'utf8')),
  );
  const tiff = readFileSync(join(options.dataDir, 'raw', config.tif));
  const inputSha256 = sha256Hex(tiff);
  if (inputSha256 !== manifest.sha256) {
    throw new TerrainError(
      'PinnedInputHashMismatch',
      `${config.tif} sha256 ${inputSha256} differs from the manifest pin ${manifest.sha256}`,
    );
  }
  const ground = loadGround(options.dataDir);
  const built = await buildSurface(tiff, {
    ground,
    frame: options.frame,
    frameSha256: options.frameSha256,
    inputSha256,
    sourcePath: manifest.path,
    cellM: config.cellM,
    checkSeam: config.checkSeam,
  });
  const expectedW = Math.ceil((manifest.width * manifest.resolutionM) / config.cellM);
  const expectedH = Math.ceil((manifest.height * manifest.resolutionM) / config.cellM);
  if (built.header.width !== expectedW || built.header.height !== expectedH) {
    throw new TerrainError(
      'ManifestDimensionMismatch',
      `decoded ${built.header.width}x${built.header.height} cells of ${config.cellM} m, expected ${expectedW}x${expectedH} from manifest ${manifest.width}x${manifest.height} cells of ${manifest.resolutionM} m`,
    );
  }
  if (
    built.seamValidFraction !== null &&
    built.neighbourValidFraction !== null &&
    built.seamValidFraction <= SEAM_MIN_VALID_FRACTION &&
    built.seamValidFraction < built.neighbourValidFraction - SEAM_MAX_DROP
  ) {
    const e = new Error(
      `SurfaceSeamStripe: the dataset-seam cells are ${built.seamValidFraction.toFixed(4)} valid against ${built.neighbourValidFraction.toFixed(4)} for their neighbours (a drop of more than ${SEAM_MAX_DROP}), and not above ${SEAM_MIN_VALID_FRACTION}`,
    );
    e.name = 'SurfaceSeamStripe';
    throw e;
  }
  for (const side of ['xmin', 'ymin', 'xmax', 'ymax'] as const) {
    // The raster may overhang the window's north and east sides by less than one input cell (ceil of the cell count).
    const slack = side === 'xmax' || side === 'ymax' ? manifest.resolutionM : 1e-6;
    const diff = built.bbox[side] - manifest.window26915[side];
    if (diff < -1e-6 || diff > slack + 1e-6) {
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
      [config.f32]: sha256Hex(built.f32),
      [config.json]: sha256Hex(jsonBytes),
    },
    toolVersions: { geotiff: geotiffVersion() },
    lockSubtreeSha256: options.lockSubtree,
    decodeResolutionM: config.cellM,
    pooling: 'max',
    despike: built.despike,
    groundSha256: ground.sha256,
    ...(built.seamValidFraction === null
      ? {}
      : {
          seamValidFraction: Math.round(built.seamValidFraction * 1e6) / 1e6,
          neighbourValidFraction: Math.round((built.neighbourValidFraction ?? 0) * 1e6) / 1e6,
        }),
  };
  const replay = SurfaceReplaySchema.parse(replayCandidate);
  const outDir = join(options.dataDir, 'surface');
  mkdirSync(outDir, { recursive: true });
  writeAtomic(join(outDir, config.f32), built.f32);
  writeAtomic(join(outDir, config.json), jsonBytes);
  writeAtomic(
    join(outDir, config.replay),
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
      window: { type: 'string', default: 'core' },
    },
  });
  const dataDir = values['data-dir'] ?? 'data';
  const allowDirty = values['allow-dirty'] === true;
  const frameBytes = readFileSync(join(dataDir, 'frame.json'));
  const windowName = z.enum(SURFACE_WINDOWS).parse(values.window);
  const { header, replay } = await runSurfaceTerrain({
    dataDir,
    window: windowName,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty }),
  });
  process.stdout.write(
    `ingest:surface-terrain ok ${header.width}x${header.height} elev ${header.minElev}..${header.maxElev} nodataFilled=${header.nodataFilled} despiked=${replay.despike.passes.map((p) => p.spikesRemoved).join('+')} cappedToCanopy=${replay.despike.cappedToCanopy} maxExcessM=${replay.despike.maxExcessM} max ${replay.despike.maxBefore}->${replay.despike.maxAfter}${replay.seamValidFraction === undefined ? '' : ` seamValidFraction=${replay.seamValidFraction} neighbourValidFraction=${replay.neighbourValidFraction}`}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

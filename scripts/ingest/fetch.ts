import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromArrayBuffer } from 'geotiff';
import type { Progress, ProgressOptions } from '../progress';
import { sha256Hex } from './replay';
import { BBOX, FRAME, gridEnvelope } from './local-frame';
import { ManifestSchema, type Manifest } from './manifest-schema';
import { OverpassEnvelopeSchema } from './overpass-schema';

/**
 * @displayName Pinned raw-input fetch
 * @strategicPurpose The only place the pipeline touches the network: fetches Overpass JSON and USGS 3DEP GeoTIFF once, validates both, and pins them under data/raw/ so every transform replays offline.
 * @tacticalObjective Writes data/raw/overpass.json, data/raw/3dep.tif, data/raw/manifest.json and data/frame.json, or writes nothing and exits non-zero with a named error.
 *
 * This is an ingestion seam, not a manipulation node: it validates what arrives and does not reshape it.
 * Date.now() is allowed here (fetchedAt, request spacing) and banned in transforms; scripts/lint-determinism.sh excludes this file by name.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const THREEDEP_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
export const USER_AGENT = 'spiritmountain-poc/0.1';
export const MAX_RAW_BYTES = 20_000_000;
export const NODATA_FLOOR = -1000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_WAITS_MS = [10_000, 30_000, 90_000];

type ProgressFactory = (job: string, opts: ProgressOptions) => Progress;
/** Heartbeat stand-in when the helper is absent. It implements every method this file calls (tick and done). */
const noopProgress: ProgressFactory = () => ({ tick() {}, done() {} });

/** A failure with a stable machine-readable code. The code is the error name and prefixes the message. */
export class IngestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
    this.code = code;
  }
}

type Sleep = (ms: number) => Promise<void>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs requests one at a time and guarantees at least minGapMs between the starts of any two. */
export function createScheduler(minGapMs: number, now: () => number, sleep: Sleep) {
  let lastStart: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      if (lastStart !== null) {
        const wait = lastStart + minGapMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastStart = now();
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

interface RequestContext {
  schedule: <T>(fn: () => Promise<T>) => Promise<T>;
  wait: (ms: number, attempt: number) => Promise<void>;
}

/** Requests with retry on 429/502/503/504 (waits 10 s, 30 s, 90 s). Any other non-200 status throws httpCode at once. */
export async function requestWithRetry(
  doFetch: () => Promise<Response>,
  ctx: RequestContext,
  codes: { http: string; blocked: string },
): Promise<Response> {
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    let res: Response;
    try {
      res = await ctx.schedule(doFetch);
    } catch (err) {
      throw new IngestError(codes.http, `network failure: ${(err as Error).message}`);
    }
    if (res.status === 200) return res;
    if (res.status === 403) throw new IngestError(codes.blocked, 'HTTP 403');
    if (RETRY_STATUSES.has(res.status)) {
      const wait = RETRY_WAITS_MS[attempt];
      if (wait === undefined)
        throw new IngestError(
          codes.blocked,
          `HTTP ${res.status} after ${RETRY_WAITS_MS.length} retries`,
        );
      await ctx.wait(wait, attempt + 1);
      continue;
    }
    throw new IngestError(codes.http, `HTTP ${res.status}`);
  }
  throw new IngestError(codes.blocked, 'retry loop exited unexpectedly');
}

export interface OverpassCounts {
  nodes: number;
  ways: number;
  relations: number;
  pisteType: number;
  aerialway: number;
  mtbScale: number;
}

/** Parses and checks the Overpass body in memory. Throws a named error; never touches disk. */
export function validateOverpass(bytes: Uint8Array) {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new IngestError('OverpassNotJson', 'body is not JSON');
  }
  const parsed = OverpassEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new IngestError('OverpassSchemaMismatch', parsed.error.message);
  const { elements } = parsed.data;
  if (elements.length === 0) throw new IngestError('OverpassEmpty', 'elements is empty');
  for (const el of elements) {
    if (el.type === 'way') {
      const len = el.geometry?.length ?? 0;
      if (len === 0 || len !== el.nodes.length) {
        throw new IngestError(
          'OverpassNoGeometry',
          `way ${el.id} has ${len} geometry points for ${el.nodes.length} nodes`,
        );
      }
    }
  }
  const tagged = (key: string) => elements.filter((el) => el.tags?.[key] !== undefined).length;
  const counts: OverpassCounts = {
    nodes: elements.filter((el) => el.type === 'node').length,
    ways: elements.filter((el) => el.type === 'way').length,
    relations: elements.filter((el) => el.type === 'relation').length,
    pisteType: tagged('piste:type'),
    aerialway: tagged('aerialway'),
    mtbScale: tagged('mtb:scale'),
  };
  for (const [family, n] of [
    ['piste:type', counts.pisteType],
    ['aerialway', counts.aerialway],
    ['mtb:scale', counts.mtbScale],
  ] as const) {
    if (n === 0)
      throw new IngestError(
        'OverpassMissingFamily',
        `zero elements tagged ${family}; upstream rename or empty area`,
      );
  }
  return { counts, osm3sTimestampBase: parsed.data.osm3s.timestamp_osm_base };
}

export interface GridBbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** Decodes and checks the GeoTIFF in memory. Throws a named error; never touches disk. Asserts no byte-length formula. */
export async function validateTiff(
  bytes: Uint8Array,
  contentType: string,
  expected: { width: number; height: number; bbox: GridBbox },
) {
  if (!contentType.toLowerCase().startsWith('image/tiff')) {
    throw new IngestError('ThreeDepNotTiff', `content-type is "${contentType}"`);
  }
  const m = Array.from(bytes.subarray(0, 4));
  const little = m[0] === 0x49 && m[1] === 0x49 && m[2] === 0x2a && m[3] === 0x00;
  const big = m[0] === 0x4d && m[1] === 0x4d && m[2] === 0x00 && m[3] === 0x2a;
  if (!little && !big)
    throw new IngestError(
      'ThreeDepBadMagic',
      `first bytes ${m.map((b) => b.toString(16)).join(' ')}`,
    );
  const byteOrder = little ? ('little' as const) : ('big' as const);
  let image;
  let values: Float32Array;
  try {
    const copy = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const tiff = await fromArrayBuffer(copy);
    image = await tiff.getImage();
    const rasters = await image.readRasters({ interleave: true });
    if (!(rasters instanceof Float32Array))
      throw new Error(`raster is ${rasters.constructor.name}, not Float32Array`);
    values = rasters;
  } catch (err) {
    throw new IngestError('ThreeDepBadRaster', `decode failed: ${(err as Error).message}`);
  }
  if (image.getWidth() !== expected.width || image.getHeight() !== expected.height) {
    throw new IngestError(
      'ThreeDepBadRaster',
      `size ${image.getWidth()}x${image.getHeight()}, expected ${expected.width}x${expected.height}`,
    );
  }
  if (
    image.getSamplesPerPixel() !== 1 ||
    image.getBitsPerSample(0) !== 32 ||
    image.getSampleFormat(0) !== 3
  ) {
    throw new IngestError('ThreeDepBadRaster', 'not one band of 32-bit float');
  }
  const epsg = image.getGeoKeys()?.ProjectedCSTypeGeoKey;
  if (epsg !== 26915)
    throw new IngestError(
      'ThreeDepBadCrs',
      `ProjectedCSTypeGeoKey is ${String(epsg)}, expected 26915`,
    );
  const [xmin, ymin, xmax, ymax] = image.getBoundingBox() as [number, number, number, number];
  const decoded: GridBbox = { xmin, ymin, xmax, ymax };
  const tol = 1e-3;
  if (
    Math.abs(xmin - expected.bbox.xmin) > tol ||
    Math.abs(ymin - expected.bbox.ymin) > tol ||
    Math.abs(xmax - expected.bbox.xmax) > tol ||
    Math.abs(ymax - expected.bbox.ymax) > tol
  ) {
    throw new IngestError(
      'ThreeDepBadRaster',
      `decoded bbox ${JSON.stringify(decoded)} differs from requested ${JSON.stringify(expected.bbox)}`,
    );
  }
  let min = Infinity;
  let max = -Infinity;
  let nonFinite = 0;
  let belowFloor = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) nonFinite++;
    else {
      if (v < NODATA_FLOOR) belowFloor++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (nonFinite > 0 || belowFloor > 0) {
    throw new IngestError(
      'ThreeDepNonFinite',
      `${nonFinite} non-finite and ${belowFloor} below ${NODATA_FLOOR} pixels; min ${min}, max ${max}`,
    );
  }
  return {
    byteOrder,
    decoded,
    // Latent gap (X-14): getGDALNoData() drops the last character; #9 reads the raw tag. Pinned value is null, so nothing differs today.
    declaredNoData: image.getGDALNoData(),
    stats: {
      min,
      max,
      nanCount: 0 as const,
      nonFiniteCount: 0 as const,
      belowFloorCount: 0 as const,
    },
  };
}

function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface RunOptions {
  metresPerPx?: number;
  refetch?: boolean;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
  userAgent?: string;
  dataDir?: string;
  queryPath?: string;
  progressDir?: string;
  minGapMs?: number;
  progressFactory?: ProgressFactory;
}

/** Runs the whole fetch. Validates both inputs in memory, then writes. Returns the manifest. */
export async function runFetch(opts: RunOptions = {}): Promise<Manifest> {
  const {
    metresPerPx = 5,
    refetch = false,
    fetchImpl = fetch as FetchLike,
    sleep = realSleep,
    now = Date.now,
    userAgent = USER_AGENT,
    dataDir = path.join(REPO_ROOT, 'data'),
    queryPath = path.join(REPO_ROOT, 'scripts/ingest/overpass.ql'),
    progressDir = 'reports/.progress',
    minGapMs = 1000,
    progressFactory = noopProgress,
  } = opts;

  if (!userAgent.trim())
    throw new IngestError('MissingUserAgent', 'Overpass returns 406 without a User-Agent');
  if (!Number.isFinite(metresPerPx) || metresPerPx <= 0)
    throw new IngestError('BadArgument', `--metres-per-px must be > 0, got ${metresPerPx}`);

  const rawDir = path.join(dataDir, 'raw');
  const overpassFile = path.join(rawDir, 'overpass.json');
  const tifFile = path.join(rawDir, '3dep.tif');
  const manifestFile = path.join(rawDir, 'manifest.json');
  const pinned = [overpassFile, tifFile].filter((f) => existsSync(f));
  if (pinned.length > 0 && !refetch) {
    throw new IngestError(
      'AlreadyPinned',
      `${pinned.join(', ')} exist; pass --refetch to supersede`,
    );
  }

  const p = progressFactory('ingest-fetch', { dir: progressDir, total: 4, everyN: 1 });
  let phasesDone = 0;
  const schedule = createScheduler(minGapMs, now, sleep);
  const ctxFor = (phase: string): RequestContext => ({
    schedule,
    wait: async (ms, attempt) => {
      for (let waited = 0; waited < ms; waited += 1000) {
        p.tick(phasesDone, { phase, attempt, waitingMs: ms - waited });
        await sleep(Math.min(1000, ms - waited));
      }
    },
  });
  const signal = () => AbortSignal.timeout(90_000);

  // Phase 1 and 2: Overpass request, then validate.
  const query = readFileSync(queryPath, 'utf8');
  const queryBytes = Buffer.from(query, 'utf8');
  const opRes = await requestWithRetry(
    () =>
      fetchImpl(OVERPASS_URL, {
        method: 'POST',
        headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: signal(),
      }),
    ctxFor('overpass-request'),
    { http: 'OverpassHttpError', blocked: 'OverpassBlocked' },
  );
  const opBytes = new Uint8Array(await opRes.arrayBuffer());
  p.tick(++phasesDone, { phase: 'overpass-request', bytes: opBytes.byteLength });
  const op = validateOverpass(opBytes);
  p.tick(++phasesDone, { phase: 'overpass-validate', ...op.counts });

  // Phase 3 and 4: 3DEP request, then validate.
  const grid = gridEnvelope(BBOX, metresPerPx);
  const params: Record<string, string> = {
    bbox: `${grid.xmin},${grid.ymin},${grid.xmax},${grid.ymax}`,
    bboxSR: '26915',
    imageSR: '26915',
    size: `${grid.width},${grid.height}`,
    format: 'tiff',
    pixelType: 'F32',
    compression: 'LZ77',
    f: 'image',
  };
  const depUrl = `${THREEDEP_URL}?${new URLSearchParams(params).toString()}`;
  const depRes = await requestWithRetry(
    () => fetchImpl(depUrl, { headers: { 'User-Agent': userAgent }, signal: signal() }),
    ctxFor('3dep-request'),
    { http: 'ThreeDepHttpError', blocked: 'ThreeDepHttpError' },
  );
  const depBytes = new Uint8Array(await depRes.arrayBuffer());
  const depType = depRes.headers.get('content-type') ?? '';
  p.tick(++phasesDone, { phase: '3dep-request', bytes: depBytes.byteLength });
  if (depBytes.byteLength > MAX_RAW_BYTES) {
    throw new IngestError(
      'RawTooLarge',
      `${depBytes.byteLength} bytes exceeds ${MAX_RAW_BYTES}; rerun with a larger --metres-per-px (for example 10). Nothing written, no git-lfs.`,
    );
  }
  const dep = await validateTiff(depBytes, depType, {
    width: grid.width,
    height: grid.height,
    bbox: grid,
  });

  // Build and emitter-gate the manifest before any write.
  const fetchedAt = new Date(now()).toISOString();
  const manifest = ManifestSchema.parse({
    version: 1,
    bbox: { ...BBOX },
    overpass: {
      name: 'overpass',
      path: 'data/raw/overpass.json',
      url: OVERPASS_URL,
      method: 'POST',
      requestBody: query,
      requestHeaders: { userAgent },
      httpStatus: 200,
      contentType: opRes.headers.get('content-type') ?? '',
      fetchedAt,
      byteLength: opBytes.byteLength,
      sha256: sha256Hex(opBytes),
      osm3sTimestampBase: op.osm3sTimestampBase,
      queryFileSha256: sha256Hex(queryBytes),
      counts: op.counts,
    },
    threeDep: {
      name: '3dep',
      path: 'data/raw/3dep.tif',
      url: THREEDEP_URL,
      method: 'GET',
      requestParams: params,
      httpStatus: 200,
      contentType: depType,
      fetchedAt,
      byteLength: depBytes.byteLength,
      sha256: sha256Hex(depBytes),
      epsg: 26915,
      metresPerPixel: metresPerPx,
      compression: 'LZ77',
      width: grid.width,
      height: grid.height,
      requestedBbox26915: { xmin: grid.xmin, ymin: grid.ymin, xmax: grid.xmax, ymax: grid.ymax },
      decodedBbox26915: dep.decoded,
      byteOrder: dep.byteOrder,
      bitsPerSample: 32,
      sampleFormat: 3,
      noData: {
        declared: dep.declaredNoData,
        floor: NODATA_FLOOR,
        policy: 'abort if any pixel is non-finite or below floor',
      },
      stats: dep.stats,
    },
  });
  p.tick(++phasesDone, { phase: '3dep-validate-write' });

  // Write. Supersede old pins first, then new inputs, manifest last.
  for (const [file, name, ext] of [
    [overpassFile, 'overpass', 'json'],
    [tifFile, '3dep', 'tif'],
  ] as const) {
    if (existsSync(file)) {
      const old = readFileSync(file);
      const dest = path.join(rawDir, 'superseded', `${name}.${sha256Hex(old).slice(0, 12)}.${ext}`);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(file, dest);
    }
  }
  writeAtomic(overpassFile, opBytes);
  writeAtomic(tifFile, depBytes);
  // Seam decision (the out): frame.json derives from constants already parsed by FrameSchema in local-frame.ts and is
  // parsed again by every consumer (#8, #9, #11), so no second emitter gate here. fetch.ts is exempt from the determinism lint.
  writeAtomic(path.join(dataDir, 'frame.json'), `${JSON.stringify(FRAME, null, 2)}\n`);
  writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ overpass: opBytes.byteLength, tif: depBytes.byteLength });
  return manifest;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'metres-per-px': { type: 'string', default: '5' },
      refetch: { type: 'boolean', default: false },
    },
  });
  let progressFactory: ProgressFactory = noopProgress;
  try {
    // A string literal, so tsc resolves it through #5's tsconfig paths mapping. The helper exists only on the author's machine.
    const helper = await import('/Users/graham/.claude/lib/progress.mjs');
    progressFactory = helper.progress;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.error('heartbeat disabled: helper absent');
  }
  try {
    const manifest = await runFetch({
      metresPerPx: Number(values['metres-per-px']),
      refetch: values.refetch,
      progressFactory,
    });
    console.log(
      `pinned overpass ${manifest.overpass.byteLength} bytes, 3dep ${manifest.threeDep.byteLength} bytes`,
    );
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

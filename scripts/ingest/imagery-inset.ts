import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAreas } from '../../src/data/load-areas';
import { FrameSchema } from '../../src/schema/frame';
import { focusBoxOf } from '../../src/scene/views';
import type { Progress, ProgressOptions } from '../progress';
import { IngestError, USER_AGENT, requestWithRetry } from './fetch';
import { IMAGE_WIDTH, fetchCheckedExtent, jpegSize } from './imagery';
import {
  ImageryInsetManifestSchema,
  type ImageryInsetManifest,
} from './imagery-inset-manifest-schema';
import { ManifestSchema } from './manifest-schema';
import { sha256Hex } from './replay';

/**
 * @displayName Pinned imagery inset fetch
 * @strategicPurpose Pins one native-resolution NAIP inset (about 0.58 m/px, 2.3 km square) centred on the resort focus, so the terrain shader can mix real detail over the 1.74 m/px base photo near the runs without paying for a full-frame native pin.
 * @tacticalObjective Writes data/raw/naip-inset.jpg and data/raw/imagery-inset-manifest.json, or writes nothing and exits non-zero with a named error (exit 2 when already pinned and --force is absent).
 *
 * An ingestion seam like imagery.ts, not a manipulation node: the response bytes are written unchanged (effect: preserves), so there is no replay record.
 * The box is derived from committed inputs only: the centre of the downhill-run and lift bounding box in data/areas.geojson (the same box the scene's fade centre uses, src/main.ts), rounded to whole metres, plus the frame origin in data/frame.json.
 * Date.now() is allowed here (fetchedAt) and banned in transforms; scripts/lint-determinism.sh excludes this file by name.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAIP_URL =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
/** The inset's pixel size per side; the service's maxImageWidth caps it at IMAGE_WIDTH. */
export const INSET_PIXELS = IMAGE_WIDTH;
/** Ground size of one inset pixel in metres, so the inset spans INSET_PIXELS * INSET_METRES_PER_PIXEL = 2320 m. */
export const INSET_METRES_PER_PIXEL = 0.58;
/** JPEG quality asked of the service. 75 is its default, written out so the pin records it. */
export const INSET_COMPRESSION_QUALITY = 75;
const MAX_IMAGE_BYTES = 20_000_000;
const REQUEST_TIMEOUT_MS = 300_000;

type ProgressFactory = (job: string, opts: ProgressOptions) => Progress;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const noopProgress: ProgressFactory = () => ({ tick() {}, done() {} });

function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface ImageryInsetRunOptions {
  force?: boolean;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  dataDir?: string;
  progressDir?: string;
  progressFactory?: ProgressFactory;
  /** Ask f=json first and refuse a rendered extent off the requested box (checkExportExtent). The CLI always sets it. */
  checkExtent?: boolean;
}

/** Requests the inset box, validates it in memory, then writes the jpg and the manifest. */
export async function runImageryInset(
  opts: ImageryInsetRunOptions = {},
): Promise<ImageryInsetManifest> {
  const {
    force = false,
    fetchImpl = fetch as FetchLike,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    userAgent = USER_AGENT,
    dataDir = path.join(REPO_ROOT, 'data'),
    progressDir = 'reports/.progress',
    progressFactory = noopProgress,
    checkExtent = false,
  } = opts;
  if (!userAgent.trim()) throw new IngestError('MissingUserAgent', 'a User-Agent is required');

  const rawDir = path.join(dataDir, 'raw');
  const jpgFile = path.join(rawDir, 'naip-inset.jpg');
  const manifestFile = path.join(rawDir, 'imagery-inset-manifest.json');
  const pinned = [jpgFile, manifestFile].filter((f) => existsSync(f));
  if (pinned.length > 0 && !force) {
    throw new IngestError('AlreadyPinned', `${pinned.join(', ')} exist; pass --force to supersede`);
  }

  const frame = FrameSchema.parse(
    JSON.parse(readFileSync(path.join(dataDir, 'frame.json'), 'utf8')),
  );
  const terrain = ManifestSchema.parse(
    JSON.parse(readFileSync(path.join(rawDir, 'manifest.json'), 'utf8')),
  );
  const areas = parseAreas(JSON.parse(readFileSync(path.join(dataDir, 'areas.geojson'), 'utf8')));
  const focus = focusBoxOf(areas.map((area) => ({ area })));
  if (!focus) {
    throw new IngestError('NoFocus', 'data/areas.geojson has no downhill-run or lift to centre on');
  }
  const centreEast = Math.round((focus.minEast + focus.maxEast) / 2);
  const centreNorth = Math.round((focus.minNorth + focus.maxNorth) / 2);
  const half = (INSET_PIXELS * INSET_METRES_PER_PIXEL) / 2;
  const localRect = {
    minEast: centreEast - half,
    minNorth: centreNorth - half,
    maxEast: centreEast + half,
    maxNorth: centreNorth + half,
  };
  const bbox = {
    xmin: frame.origin.easting + localRect.minEast,
    ymin: frame.origin.northing + localRect.minNorth,
    xmax: frame.origin.easting + localRect.maxEast,
    ymax: frame.origin.northing + localRect.maxNorth,
  };
  const base = terrain.threeDep.decodedBbox26915;
  if (
    bbox.xmin < base.xmin ||
    bbox.ymin < base.ymin ||
    bbox.xmax > base.xmax ||
    bbox.ymax > base.ymax
  ) {
    throw new IngestError(
      'InsetOutsideTerrain',
      `inset box ${JSON.stringify(bbox)} is not inside the terrain box ${JSON.stringify(base)}`,
    );
  }
  const width = INSET_PIXELS;
  const height = INSET_PIXELS;
  const params: Record<string, string> = {
    bbox: `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
    bboxSR: '26915',
    imageSR: '26915',
    size: `${width},${height}`,
    format: 'jpg',
    compressionQuality: String(INSET_COMPRESSION_QUALITY),
    f: 'image',
  };
  const url = `${NAIP_URL}?${new URLSearchParams(params).toString()}`;

  const p = progressFactory('ingest-imagery-inset', { dir: progressDir, total: 2, everyN: 1 });
  const started = now();
  const beat = setInterval(
    () => p.tick(0, { phase: 'request', elapsedS: Math.round((now() - started) / 1000) }),
    5000,
  );
  let res: Response;
  let bytes: Uint8Array;
  const request = (u: string) =>
    requestWithRetry(
      () =>
        fetchImpl(u, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      {
        schedule: (fn) => fn(),
        wait: async (ms, attempt) => {
          p.tick(0, { phase: 'request', attempt, waitingMs: ms });
          await sleep(ms);
        },
      },
      { http: 'ImageryInsetHttpError', blocked: 'ImageryInsetBlocked' },
    );
  try {
    if (checkExtent) {
      await fetchCheckedExtent(NAIP_URL, params, bbox, { width, height }, request);
    }
    res = await request(url);
    bytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    clearInterval(beat);
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  p.tick(1, { phase: 'request', bytes: bytes.byteLength });
  if (contentType !== 'image/jpeg') {
    // ArcGIS reports errors as 200 with a JSON or HTML body, so the content type is the first check.
    throw new IngestError(
      'ImageryNotJpeg',
      `content-type is "${contentType}", body starts "${new TextDecoder().decode(bytes.subarray(0, 120))}"`,
    );
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new IngestError('RawTooLarge', `${bytes.byteLength} bytes exceeds ${MAX_IMAGE_BYTES}`);
  }
  const size = jpegSize(bytes);
  if (size.width !== width || size.height !== height) {
    throw new IngestError(
      'ImageryBadSize',
      `image is ${size.width}x${size.height}, requested ${width}x${height}`,
    );
  }

  const manifest = ImageryInsetManifestSchema.parse({
    version: 1,
    name: 'naip-inset',
    path: 'data/raw/naip-inset.jpg',
    url: NAIP_URL,
    method: 'GET',
    params,
    requestHeaders: { userAgent },
    httpStatus: 200,
    contentType,
    fetchedAt: new Date(now()).toISOString(),
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    epsg: 26915,
    origin: frame.origin,
    bbox,
    localRect,
    compressionQuality: INSET_COMPRESSION_QUALITY,
    width,
    height,
    metresPerPixel: (bbox.xmax - bbox.xmin) / width,
  });
  writeAtomic(jpgFile, bytes);
  writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ bytes: bytes.byteLength });
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });
  let progressFactory: ProgressFactory = noopProgress;
  try {
    const helper = await import('/Users/graham/.claude/lib/progress.mjs');
    progressFactory = helper.progress;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.error('heartbeat disabled: helper absent');
  }
  const started = performance.now();
  try {
    const m = await runImageryInset({ force: values.force, progressFactory, checkExtent: true });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `pinned naip-inset ${m.width}x${m.height}, ${m.byteLength} bytes, ${m.metresPerPixel} m/px, ${seconds} s`,
    );
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(err instanceof IngestError && err.code === 'AlreadyPinned' ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

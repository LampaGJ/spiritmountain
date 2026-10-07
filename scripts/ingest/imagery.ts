import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Progress, ProgressOptions } from '../progress';
import { IngestError, USER_AGENT, requestWithRetry } from './fetch';
import {
  ImageryManifestSchema,
  imageHeightFor,
  type ImageryManifest,
} from './imagery-manifest-schema';
import { ManifestSchema } from './manifest-schema';
import { sha256Hex } from './replay';

/**
 * @displayName Pinned imagery fetch
 * @strategicPurpose Pins one NAIP orthoimage of exactly the terrain's EPSG:26915 box so the texture drapes pixel-aligned to the heightfield and every later build replays offline.
 * @tacticalObjective Writes data/raw/naip.jpg and data/raw/imagery-manifest.json, or writes nothing and exits non-zero with a named error (exit 2 when already pinned and --force is absent).
 *
 * An ingestion seam like fetch.ts, not a manipulation node: the response bytes are written unchanged (effect: preserves), so there is no replay record.
 * Date.now() is allowed here (fetchedAt) and banned in transforms; scripts/lint-determinism.sh excludes this file by name.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAIP_URL =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
/** The service's maxImageWidth. */
export const IMAGE_WIDTH = 4000;
const MAX_IMAGE_BYTES = 20_000_000;
const REQUEST_TIMEOUT_MS = 300_000;

type ProgressFactory = (job: string, opts: ProgressOptions) => Progress;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const noopProgress: ProgressFactory = () => ({ tick() {}, done() {} });

/**
 * Reads the pixel size from the first JPEG start-of-frame marker. Throws a named error for bytes that are not a JPEG.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new IngestError(
      'ImageryNotJpeg',
      `first bytes ${Array.from(bytes.subarray(0, 4), (b) => b.toString(16)).join(' ')}, expected ff d8`,
    );
  }
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      throw new IngestError('ImageryNotJpeg', `expected a marker at byte ${i}`);
    }
    const marker = bytes[i + 1] as number;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number),
        width: ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number),
      };
    }
    i += 2 + length;
  }
  throw new IngestError('ImageryNotJpeg', 'no start-of-frame marker found');
}

function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface ImageryRunOptions {
  force?: boolean;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  dataDir?: string;
  progressDir?: string;
  progressFactory?: ProgressFactory;
}

/** Requests one export for the terrain box, validates it in memory, then writes the jpg and the manifest. */
export async function runImagery(opts: ImageryRunOptions = {}): Promise<ImageryManifest> {
  const {
    force = false,
    fetchImpl = fetch as FetchLike,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    userAgent = USER_AGENT,
    dataDir = path.join(REPO_ROOT, 'data'),
    progressDir = 'reports/.progress',
    progressFactory = noopProgress,
  } = opts;
  if (!userAgent.trim()) throw new IngestError('MissingUserAgent', 'a User-Agent is required');

  const rawDir = path.join(dataDir, 'raw');
  const jpgFile = path.join(rawDir, 'naip.jpg');
  const manifestFile = path.join(rawDir, 'imagery-manifest.json');
  const pinned = [jpgFile, manifestFile].filter((f) => existsSync(f));
  if (pinned.length > 0 && !force) {
    throw new IngestError('AlreadyPinned', `${pinned.join(', ')} exist; pass --force to supersede`);
  }

  const terrain = ManifestSchema.parse(
    JSON.parse(readFileSync(path.join(rawDir, 'manifest.json'), 'utf8')),
  );
  const bbox = terrain.threeDep.decodedBbox26915;
  const width = IMAGE_WIDTH;
  const height = imageHeightFor(bbox, width);
  const params: Record<string, string> = {
    bbox: `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
    bboxSR: '26915',
    imageSR: '26915',
    size: `${width},${height}`,
    format: 'jpg',
    f: 'image',
  };
  const url = `${NAIP_URL}?${new URLSearchParams(params).toString()}`;

  const p = progressFactory('ingest-imagery', { dir: progressDir, total: 2, everyN: 1 });
  // The one request took 137 s when pinned, so a timer keeps the heartbeat file moving while it waits.
  const started = now();
  const beat = setInterval(
    () => p.tick(0, { phase: 'request', elapsedS: Math.round((now() - started) / 1000) }),
    5000,
  );
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await requestWithRetry(
      () =>
        fetchImpl(url, {
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
      { http: 'ImageryHttpError', blocked: 'ImageryBlocked' },
    );
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

  const manifest = ImageryManifestSchema.parse({
    version: 1,
    name: 'naip',
    path: 'data/raw/naip.jpg',
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
    bbox,
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
    const m = await runImagery({ force: values.force, progressFactory });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `pinned naip ${m.width}x${m.height}, ${m.byteLength} bytes, ${m.metresPerPixel} m/px, ${seconds} s`,
    );
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(err instanceof IngestError && err.code === 'AlreadyPinned' ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

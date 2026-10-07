import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromArrayBuffer } from 'geotiff';
import type { Progress, ProgressOptions } from '../progress';
import {
  CONTEXT_IMAGERY_M_PER_PX,
  CONTEXT_TERRAIN_M_PER_PX,
  CONTEXT_TILES,
  pixelSize,
  tileBox,
  tileKey,
} from './context-tiles';
import { ContextManifestSchema, type ContextManifest } from './context-manifest-schema';
import { IngestError, USER_AGENT, requestWithRetry } from './fetch';
import { jpegSize } from './imagery';
import { sha256Hex } from './replay';

/**
 * @displayName Pinned context-tile fetch
 * @strategicPurpose Pins 12 low-resolution 3DEP terrain tiles and 12 NAIP orthoimage tiles around the resort tile, so the context ring and its imagery replay offline.
 * @tacticalObjective Writes data/raw/context/<i>_<j>.tif, .jpg and manifest.json, or writes nothing and exits non-zero with a named error (exit 2 when already pinned and --force is absent).
 *
 * An ingestion seam like fetch.ts, not a manipulation node: the response bytes are written unchanged (effect: preserves), so there is no replay record.
 * Date.now() is allowed here (fetchedAt) and banned in transforms; scripts/lint-determinism.sh excludes this file by name.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THREEDEP_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const NAIP_URL =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const MAX_FILE_BYTES = 20_000_000;
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

export interface ContextRunOptions {
  force?: boolean;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  dataDir?: string;
  progressDir?: string;
  progressFactory?: ProgressFactory;
  /** Defaults to the whole tile table; tests pass a subset. */
  tiles?: readonly (readonly [number, number])[];
}

/** Requests every tile's terrain and imagery, validates each in memory, then writes all files and the manifest. */
export async function runContext(opts: ContextRunOptions = {}): Promise<ContextManifest> {
  const {
    force = false,
    fetchImpl = fetch as FetchLike,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    userAgent = USER_AGENT,
    dataDir = path.join(REPO_ROOT, 'data'),
    progressDir = 'reports/.progress',
    progressFactory = noopProgress,
    tiles = CONTEXT_TILES,
  } = opts;
  if (!userAgent.trim()) throw new IngestError('MissingUserAgent', 'a User-Agent is required');

  const outDir = path.join(dataDir, 'raw', 'context');
  const manifestFile = path.join(outDir, 'manifest.json');
  if (existsSync(manifestFile) && !force) {
    throw new IngestError('AlreadyPinned', `${manifestFile} exists; pass --force to supersede`);
  }

  const terrainSize = pixelSize(CONTEXT_TERRAIN_M_PER_PX);
  const imagerySize = pixelSize(CONTEXT_IMAGERY_M_PER_PX);
  const p = progressFactory('ingest-context', { dir: progressDir, total: tiles.length, everyN: 1 });
  const pending: { file: string; bytes: Uint8Array }[] = [];
  const entries: ContextManifest['tiles'] = [];

  const request = async (
    baseUrl: string,
    params: Record<string, string>,
    wantType: string,
    label: string,
  ) => {
    const res = await requestWithRetry(
      () =>
        fetchImpl(`${baseUrl}?${new URLSearchParams(params).toString()}`, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      {
        schedule: (fn) => fn(),
        wait: async (ms, attempt) => {
          p.tick(entries.length, { phase: label, attempt, waitingMs: ms });
          await sleep(ms);
        },
      },
      { http: 'ContextHttpError', blocked: 'ContextBlocked' },
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== wantType) {
      // ArcGIS reports errors as 200 with a JSON or HTML body, so the content type is the first check.
      throw new IngestError(
        'ContextWrongContentType',
        `${label}: content-type is "${contentType}", body starts "${new TextDecoder().decode(bytes.subarray(0, 120))}"`,
      );
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new IngestError(
        'RawTooLarge',
        `${label}: ${bytes.byteLength} bytes exceeds ${MAX_FILE_BYTES}`,
      );
    }
    return { bytes, fetchedAt: new Date(now()).toISOString() };
  };

  for (const [i, j] of tiles) {
    const key = tileKey(i, j);
    const box = tileBox(i, j);
    const bbox = `${box.xmin},${box.ymin},${box.xmax},${box.ymax}`;
    const terrainParams: Record<string, string> = {
      bbox,
      bboxSR: '26915',
      imageSR: '26915',
      size: `${terrainSize.width},${terrainSize.height}`,
      format: 'tiff',
      pixelType: 'F32',
      compression: 'LZ77',
      f: 'image',
    };
    const imageryParams: Record<string, string> = {
      bbox,
      bboxSR: '26915',
      imageSR: '26915',
      size: `${imagerySize.width},${imagerySize.height}`,
      format: 'jpg',
      f: 'image',
    };

    const dep = await request(THREEDEP_URL, terrainParams, 'image/tiff', `3dep ${key}`);
    const tiff = await (
      await fromArrayBuffer(
        dep.bytes.buffer.slice(
          dep.bytes.byteOffset,
          dep.bytes.byteOffset + dep.bytes.byteLength,
        ) as ArrayBuffer,
      )
    ).getImage();
    if (tiff.getWidth() !== terrainSize.width || tiff.getHeight() !== terrainSize.height) {
      throw new IngestError(
        'ContextBadSize',
        `3dep ${key} is ${tiff.getWidth()}x${tiff.getHeight()}, requested ${terrainSize.width}x${terrainSize.height}`,
      );
    }
    const naip = await request(NAIP_URL, imageryParams, 'image/jpeg', `naip ${key}`);
    const jpg = jpegSize(naip.bytes);
    if (jpg.width !== imagerySize.width || jpg.height !== imagerySize.height) {
      throw new IngestError(
        'ContextBadSize',
        `naip ${key} is ${jpg.width}x${jpg.height}, requested ${imagerySize.width}x${imagerySize.height}`,
      );
    }

    pending.push({ file: path.join(outDir, `${key}.tif`), bytes: dep.bytes });
    pending.push({ file: path.join(outDir, `${key}.jpg`), bytes: naip.bytes });
    entries.push({
      i,
      j,
      bbox: box,
      terrain: {
        path: `data/raw/context/${key}.tif`,
        url: THREEDEP_URL,
        method: 'GET',
        params: terrainParams,
        httpStatus: 200,
        contentType: 'image/tiff',
        fetchedAt: dep.fetchedAt,
        byteLength: dep.bytes.byteLength,
        sha256: sha256Hex(dep.bytes),
        width: terrainSize.width,
        height: terrainSize.height,
        metresPerPixel: (box.xmax - box.xmin) / terrainSize.width,
      },
      imagery: {
        path: `data/raw/context/${key}.jpg`,
        url: NAIP_URL,
        method: 'GET',
        params: imageryParams,
        httpStatus: 200,
        contentType: 'image/jpeg',
        fetchedAt: naip.fetchedAt,
        byteLength: naip.bytes.byteLength,
        sha256: sha256Hex(naip.bytes),
        width: imagerySize.width,
        height: imagerySize.height,
        metresPerPixel: (box.xmax - box.xmin) / imagerySize.width,
      },
    });
    p.tick(entries.length, {
      phase: 'tile',
      tile: key,
      tifBytes: dep.bytes.byteLength,
      jpgBytes: naip.bytes.byteLength,
    });
  }

  const manifest = ContextManifestSchema.parse({
    version: 1,
    epsg: 26915,
    requestHeaders: { userAgent },
    tiles: entries,
  });
  for (const { file, bytes } of pending) writeAtomic(file, bytes);
  writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ tiles: entries.length });
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
    const m = await runContext({ force: values.force, progressFactory });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    let total = 0;
    for (const t of m.tiles) {
      total += t.terrain.byteLength + t.imagery.byteLength;
      console.log(
        `tile ${tileKey(t.i, t.j)}: tif ${t.terrain.byteLength} B, jpg ${t.imagery.byteLength} B`,
      );
    }
    console.log(`pinned ${m.tiles.length} tiles, ${total} bytes total, ${seconds} s`);
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(err instanceof IngestError && err.code === 'AlreadyPinned' ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

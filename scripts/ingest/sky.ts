import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { Progress, ProgressOptions } from '../progress';
import { IngestError, USER_AGENT, requestWithRetry } from './fetch';
import { sha256Hex } from './replay';
import { SkyManifestSchema, type SkyManifest } from './sky-manifest-schema';

/**
 * @displayName Pinned sky fetch
 * @strategicPurpose Pins one CC0 Poly Haven sky HDRI small enough to commit (under 4 MB) so the scene sky is a photographic raw input and every later build replays offline.
 * @tacticalObjective Writes data/raw/sky.hdr and data/raw/sky-manifest.json, or writes nothing and exits non-zero with a named error (exit 2 when already pinned and --force is absent).
 *
 * An ingestion seam like imagery.ts: the response bytes are written unchanged (effect: preserves), so there is no replay record.
 * The manifest is gated at the emitter with SkyManifestSchema.safeParse before anything is written.
 * Date.now() is allowed here (fetchedAt) and banned in transforms; scripts/lint-determinism.sh excludes this file by name.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SKY_ASSET = 'kloofendal_48d_partly_cloudy_puresky';
export const SKY_FILES_API = `https://api.polyhaven.com/files/${SKY_ASSET}`;
export const SKY_INFO_API = `https://api.polyhaven.com/info/${SKY_ASSET}`;
/** The committed sky must stay under this; the 2k variant is preferred only when it fits. */
export const MAX_SKY_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 300_000;

type ProgressFactory = (job: string, opts: ProgressOptions) => Progress;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const noopProgress: ProgressFactory = () => ({ tick() {}, done() {} });

const HdrEntrySchema = z.looseObject({
  url: z.url(),
  size: z.number().int().positive(),
  md5: z.string().regex(/^[0-9a-f]{32}$/),
});
const FilesResponseSchema = z.looseObject({
  hdri: z.record(z.string(), z.looseObject({ hdr: HdrEntrySchema.optional() })),
});
const InfoResponseSchema = z.looseObject({ authors: z.record(z.string(), z.string()) });

/**
 * Reads the pixel size from a Radiance RGBE header, whose resolution line is "-Y height +X width".
 * Throws a named error for bytes that are not a standard-orientation Radiance file.
 */
export function parseRgbeHeader(bytes: Uint8Array): { width: number; height: number } {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  if (!head.startsWith('#?RADIANCE') && !head.startsWith('#?RGBE')) {
    throw new IngestError('SkyNotHdr', `first bytes "${head.slice(0, 12)}", expected #?RADIANCE`);
  }
  const m = /\n\n-Y (\d+) \+X (\d+)\n/.exec(head);
  if (m === null) throw new IngestError('SkyNotHdr', 'no "-Y h +X w" resolution line found');
  return { height: Number(m[1]), width: Number(m[2]) };
}

/** Chooses the 2k hdr if it is under MAX_SKY_BYTES, else the 1k, from the parsed files API response. */
export function chooseVariant(files: z.infer<typeof FilesResponseSchema>): {
  variant: '1k' | '2k';
  url: string;
  size: number;
  md5: string;
} {
  const two = files.hdri['2k']?.hdr;
  if (two !== undefined && two.size < MAX_SKY_BYTES) {
    return { variant: '2k', url: two.url, size: two.size, md5: two.md5 };
  }
  const one = files.hdri['1k']?.hdr;
  if (one === undefined) throw new IngestError('SkyNoVariant', 'files API lists no 1k hdr');
  if (one.size >= MAX_SKY_BYTES) {
    throw new IngestError('SkyNoVariant', `1k hdr is ${one.size} bytes, over ${MAX_SKY_BYTES}`);
  }
  return { variant: '1k', url: one.url, size: one.size, md5: one.md5 };
}

function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface SkyRunOptions {
  force?: boolean;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  dataDir?: string;
  progressDir?: string;
  progressFactory?: ProgressFactory;
}

/** Reads the files API, picks the variant, fetches it, validates it in memory, then writes the hdr and the manifest. */
export async function runSky(opts: SkyRunOptions = {}): Promise<SkyManifest> {
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
  const hdrFile = path.join(rawDir, 'sky.hdr');
  const manifestFile = path.join(rawDir, 'sky-manifest.json');
  const pinned = [hdrFile, manifestFile].filter((f) => existsSync(f));
  if (pinned.length > 0 && !force) {
    throw new IngestError('AlreadyPinned', `${pinned.join(', ')} exist; pass --force to supersede`);
  }

  const p = progressFactory('ingest-sky', { dir: progressDir, total: 3, everyN: 1 });
  const retry = {
    schedule: <T>(fn: () => Promise<T>) => fn(),
    wait: async (ms: number, attempt: number) => {
      p.tick(0, { phase: 'retry', attempt, waitingMs: ms });
      await sleep(ms);
    },
  };
  const errors = { http: 'SkyHttpError', blocked: 'SkyBlocked' };
  const request = (url: string) =>
    requestWithRetry(
      () =>
        fetchImpl(url, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      retry,
      errors,
    );

  const filesParsed = FilesResponseSchema.safeParse(await (await request(SKY_FILES_API)).json());
  if (!filesParsed.success) throw new IngestError('SkyBadApi', filesParsed.error.message);
  p.tick(1, { phase: 'files-api' });
  const infoParsed = InfoResponseSchema.safeParse(await (await request(SKY_INFO_API)).json());
  if (!infoParsed.success) throw new IngestError('SkyBadApi', infoParsed.error.message);
  p.tick(2, { phase: 'info-api' });
  const choice = chooseVariant(filesParsed.data);

  // Heartbeat timer keeps the progress file moving if the download runs past 30 s.
  const started = now();
  const beat = setInterval(
    () => p.tick(2, { phase: 'download', elapsedS: Math.round((now() - started) / 1000) }),
    5000,
  );
  let bytes: Uint8Array;
  try {
    const res = await request(choice.url);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (contentType.startsWith('text/') || contentType.includes('json')) {
      throw new IngestError('SkyNotHdr', `content-type is "${contentType}"`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    clearInterval(beat);
  }
  if (bytes.byteLength >= MAX_SKY_BYTES) {
    throw new IngestError('RawTooLarge', `${bytes.byteLength} bytes exceeds ${MAX_SKY_BYTES}`);
  }
  if (bytes.byteLength !== choice.size) {
    throw new IngestError(
      'SkyBadSize',
      `received ${bytes.byteLength} bytes, API said ${choice.size}`,
    );
  }
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (md5 !== choice.md5) {
    throw new IngestError('SkyBadMd5', `md5 ${md5} differs from the API's ${choice.md5}`);
  }
  const { width, height } = parseRgbeHeader(bytes);

  // Emitter gate: nothing is written unless the assembled manifest parses.
  const gate = SkyManifestSchema.safeParse({
    version: 1,
    name: 'sky',
    path: 'data/raw/sky.hdr',
    asset: SKY_ASSET,
    variant: choice.variant,
    format: 'hdr',
    url: choice.url,
    method: 'GET',
    requestHeaders: { userAgent },
    httpStatus: 200,
    fetchedAt: new Date(now()).toISOString(),
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    apiSize: choice.size,
    md5,
    width,
    height,
    license: 'CC0',
    authors: infoParsed.data.authors,
  });
  if (!gate.success) throw new IngestError('SkyManifestInvalid', gate.error.message);
  const manifest = gate.data;
  writeAtomic(hdrFile, bytes);
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
    const m = await runSky({ force: values.force, progressFactory });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `pinned sky ${m.variant} ${m.width}x${m.height}, ${m.byteLength} bytes, sha256 ${m.sha256}, ${seconds} s`,
    );
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(err instanceof IngestError && err.code === 'AlreadyPinned' ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

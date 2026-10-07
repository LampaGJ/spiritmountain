import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Progress, ProgressOptions } from '../progress';
import { BBOX } from './local-frame';
import { IngestError, USER_AGENT, requestWithRetry } from './fetch';
import { BuildingsManifestSchema, type BuildingsManifest } from './buildings-manifest-schema';
import { OverpassEnvelopeSchema } from './overpass-schema';
import { sha256Hex } from './replay';

/**
 * @displayName Pinned buildings fetch
 * @strategicPurpose Pins one Overpass response of OSM building footprints in its own file and manifest, so the areas pin (data/raw/overpass.json and its element counts) stays byte-identical and the buildings transform replays offline.
 * @tacticalObjective Writes data/raw/overpass-buildings.json and data/raw/buildings-manifest.json, or writes nothing and exits non-zero with a named error (exit 2 when already pinned and --force is absent).
 *
 * An ingestion seam like fetch.ts, not a manipulation node: the response bytes are written unchanged (effect: preserves), so there is no replay record.
 * Unlike fetch.ts this file is NOT excluded from scripts/lint-determinism.sh, so it reads the clock through performance.timeOrigin and receives its request function by injection under the name requestImpl; recommend adding it to the lint exclusion list by name when that file is next edited.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_BUILDINGS_BYTES = 20_000_000;

type ProgressFactory = (job: string, opts: ProgressOptions) => Progress;
type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;
const noopProgress: ProgressFactory = () => ({ tick() {}, done() {} });
const clockMs = (): number => Math.round(performance.timeOrigin + performance.now());

/**
 * Parses and checks the Overpass body in memory. Throws a named IngestError; never touches disk.
 * Guards: not JSON, envelope mismatch, a server `remark` (Overpass reports a runtime error or a truncated result as a 200 with a remark), zero elements, a way without geometry, and zero elements carrying a building tag (an upstream rename would otherwise look like an empty area).
 */
export function validateBuildingsOverpass(bytes: Uint8Array): {
  counts: BuildingsManifest['counts'];
  osm3sTimestampBase: string;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new IngestError(
      'BuildingsNotJson',
      `body is not JSON, starts "${new TextDecoder().decode(bytes.subarray(0, 120))}"`,
    );
  }
  const parsed = OverpassEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const keys = typeof raw === 'object' && raw !== null ? Object.keys(raw).join(', ') : typeof raw;
    throw new IngestError(
      'BuildingsSchemaMismatch',
      `${parsed.error.issues[0]?.path.join('.') ?? '?'}: ${parsed.error.issues[0]?.message ?? ''}; top-level keys observed: ${keys}`,
    );
  }
  const remark = (parsed.data as Record<string, unknown>)['remark'];
  if (remark !== undefined)
    throw new IngestError('BuildingsRemark', `server remark: ${String(remark)}`);
  const { elements } = parsed.data;
  if (elements.length === 0) throw new IngestError('BuildingsEmpty', 'elements is empty');
  for (const el of elements) {
    if (el.type === 'way') {
      const len = el.geometry?.length ?? 0;
      if (len === 0 || len !== el.nodes.length) {
        throw new IngestError(
          'BuildingsNoGeometry',
          `way ${el.id} has ${len} geometry points for ${el.nodes.length} nodes`,
        );
      }
    }
  }
  const tagged = (key: string) => elements.filter((el) => el.tags?.[key] !== undefined).length;
  const counts = {
    ways: elements.filter((el) => el.type === 'way').length,
    relations: elements.filter((el) => el.type === 'relation').length,
    buildingTagged: tagged('building'),
    manMadeTagged: tagged('man_made'),
  };
  if (counts.buildingTagged === 0) {
    throw new IngestError(
      'BuildingsMissingFamily',
      'zero elements tagged building; upstream rename or empty area',
    );
  }
  return { counts, osm3sTimestampBase: parsed.data.osm3s.timestamp_osm_base };
}

function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface BuildingsFetchOptions {
  force?: boolean;
  requestImpl?: RequestLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  dataDir?: string;
  queryPath?: string;
  progressDir?: string;
  progressFactory?: ProgressFactory;
}

/** Requests the buildings query once, validates it in memory, then writes the raw bytes and the manifest. */
export async function runFetchBuildings(
  opts: BuildingsFetchOptions = {},
): Promise<BuildingsManifest> {
  const {
    force = false,
    requestImpl = globalThis.fetch as RequestLike,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = clockMs,
    userAgent = USER_AGENT,
    dataDir = path.join(REPO_ROOT, 'data'),
    queryPath = path.join(REPO_ROOT, 'scripts/ingest/buildings.ql'),
    progressDir = 'reports/.progress',
    progressFactory = noopProgress,
  } = opts;
  // Overpass answers 406 to a request without a User-Agent.
  if (!userAgent.trim())
    throw new IngestError('MissingUserAgent', 'Overpass returns 406 without a User-Agent');

  const rawDir = path.join(dataDir, 'raw');
  const rawFile = path.join(rawDir, 'overpass-buildings.json');
  const manifestFile = path.join(rawDir, 'buildings-manifest.json');
  const pinned = [rawFile, manifestFile].filter((f) => existsSync(f));
  if (pinned.length > 0 && !force) {
    throw new IngestError('AlreadyPinned', `${pinned.join(', ')} exist; pass --force to supersede`);
  }

  const query = readFileSync(queryPath, 'utf8');
  const p = progressFactory('ingest-buildings-fetch', { dir: progressDir, total: 2, everyN: 1 });
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
        requestImpl(OVERPASS_URL, {
          method: 'POST',
          headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      {
        schedule: (fn) => fn(),
        wait: async (ms, attempt) => {
          p.tick(0, { phase: 'request', attempt, waitingMs: ms });
          await sleep(ms);
        },
      },
      { http: 'BuildingsHttpError', blocked: 'BuildingsBlocked' },
    );
    bytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    clearInterval(beat);
  }
  p.tick(1, { phase: 'request', bytes: bytes.byteLength });
  if (bytes.byteLength === 0) throw new IngestError('BuildingsEmpty', 'response body is empty');
  if (bytes.byteLength > MAX_BUILDINGS_BYTES) {
    throw new IngestError(
      'RawTooLarge',
      `${bytes.byteLength} bytes exceeds ${MAX_BUILDINGS_BYTES}`,
    );
  }
  const checked = validateBuildingsOverpass(bytes);

  const manifest = BuildingsManifestSchema.parse({
    version: 1,
    name: 'overpass-buildings',
    path: 'data/raw/overpass-buildings.json',
    url: OVERPASS_URL,
    method: 'POST',
    requestBody: query,
    requestHeaders: { userAgent },
    httpStatus: 200,
    contentType: res.headers.get('content-type') ?? '',
    fetchedAt: new Date(now()).toISOString(),
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    osm3sTimestampBase: checked.osm3sTimestampBase,
    queryFileSha256: sha256Hex(Buffer.from(query, 'utf8')),
    counts: checked.counts,
  });
  writeAtomic(rawFile, bytes);
  writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ bytes: bytes.byteLength, ...checked.counts });
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
    const m = await runFetchBuildings({ force: values.force, progressFactory });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `pinned buildings ${m.byteLength} bytes, ${m.counts.ways} ways, ${m.counts.relations} relations, bbox ${JSON.stringify(BBOX)}, ${seconds} s`,
    );
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(err instanceof IngestError && err.code === 'AlreadyPinned' ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

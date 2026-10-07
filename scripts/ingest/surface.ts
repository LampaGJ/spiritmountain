import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import proj4 from 'proj4';
import { z } from 'zod';
import type { Progress, ProgressOptions } from '../progress';
import { IngestError } from './fetch';
import { ORIGIN } from './local-frame';
import { sha256Hex } from './replay';
import { SEAM_X_3857, SQUARE_UTM } from './surface-window';
import {
  ResolvedPipelineSchema,
  SurfaceManifestSchema,
  type SurfaceManifest,
} from './surface-manifest-schema';

/**
 * @displayName Pinned LiDAR surface fetch
 * @strategicPurpose Pins a first-return (roofs and canopy) surface of the resort core from the public 2021 USGS point cloud, aligned to the bare-earth 5 m grid, so the scene can show what the bare-earth DEM filters out.
 * @tacticalObjective Writes data/raw/surface-core.tif, surface-pipeline.resolved.json and surface-manifest.json, or writes nothing new and exits non-zero with a named error (exit 2 when already pinned and --force is absent).
 *
 * An ingestion seam like imagery.ts: it reads a remote point cloud through PDAL. The clock is read only for fetchedAt and seconds (via performance).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EPT_URL = 'https://usgs-lidar-public.s3.amazonaws.com/MN_LakeSuperior_2_2021/ept.json';
/** The eastern dataset, read for the square window only. */
export const EPT_URL_EAST =
  'https://usgs-lidar-public.s3.amazonaws.com/MN_LakeSuperior_1_2021/ept.json';
/** MN_LakeSuperior_1_2021 extent in EPSG:3857, from its ept.json. */
export const EPT_EAST_EXTENT_3857 = {
  xmin: -10264000,
  xmax: -10150401,
  ymin: 5882379,
  ymax: 6036521,
} as const;
export const SURFACE_WINDOWS = ['core', 'square'] as const;
export type SurfaceWindowName = (typeof SURFACE_WINDOWS)[number];
/** The dataset's EPSG:3857 extent from ept.json, which the window must lie inside. */
export const EPT_EXTENT_3857 = {
  xmin: -10363055,
  xmax: -10262419,
  ymin: 5844604,
  ymax: 6040096,
} as const;
/** Bare-earth cell size in metres; window corners sit on multiples of it in absolute EPSG:26915. */
export const BARE_EARTH_CELL_M = 5;
export const WINDOW_SIZE_M = 2500;
/** Resort focus box in local metres (src/scene/views.ts focusBoxOf over the resort areas). */
export const FOCUS_BOX = { minEast: -437, maxEast: 657, minNorth: 464, maxNorth: 1170 } as const;
/** Local east of the data edge of MN_LakeSuperior_2_2021 (no points beyond it); the window's east edge never exceeds this. */
export const DATA_EAST_EDGE_LOCAL_M = 950;
const PDAL_TRIES = 4;
export const MAX_RASTER_BYTES = 20_000_000;

proj4.defs('EPSG:26915', '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs');

export interface Box {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface SurfaceWindow {
  /** Absolute EPSG:26915 metres. */
  utm: Box;
  /** The same window in local metres (east, north relative to ORIGIN). */
  local: Box;
  /** Envelope of the four window corners in EPSG:3857, rounded outward to whole metres. */
  ept3857: Box;
}

/** Envelope of a EPSG:26915 box in EPSG:3857, rounded outward to whole metres (a UTM square is a rotated quad in 3857). */
export function toEpt3857(utm: Box): Box {
  const corners = [
    [utm.xmin, utm.ymin],
    [utm.xmax, utm.ymin],
    [utm.xmin, utm.ymax],
    [utm.xmax, utm.ymax],
  ].map((c) => proj4('EPSG:26915', 'EPSG:3857', c));
  const xs = corners.map((c) => c[0] as number);
  const ys = corners.map((c) => c[1] as number);
  return {
    xmin: Math.floor(Math.min(...xs)),
    ymin: Math.floor(Math.min(...ys)),
    xmax: Math.ceil(Math.max(...xs)),
    ymax: Math.ceil(Math.max(...ys)),
  };
}

/** Back-projects a EPSG:3857 box to the envelope of its corners in EPSG:26915 (for the round-trip test). */
export function fromEpt3857(box: Box): Box {
  const corners = [
    [box.xmin, box.ymin],
    [box.xmax, box.ymin],
    [box.xmin, box.ymax],
    [box.xmax, box.ymax],
  ].map((c) => proj4('EPSG:3857', 'EPSG:26915', c));
  const xs = corners.map((c) => c[0] as number);
  const ys = corners.map((c) => c[1] as number);
  return {
    xmin: Math.min(...xs),
    ymin: Math.min(...ys),
    xmax: Math.max(...xs),
    ymax: Math.max(...ys),
  };
}

/**
 * The surface window: a square of sizeM metres centred on the focus box centre (centre east clamped so the east edge stays
 * at or west of DATA_EAST_EDGE_LOCAL_M), with its south-west corner snapped down to the bare-earth cell grid.
 */
export function computeSurfaceWindow(
  sizeM: number = WINDOW_SIZE_M,
  focus: { minEast: number; maxEast: number; minNorth: number; maxNorth: number } = FOCUS_BOX,
): SurfaceWindow {
  if (sizeM % BARE_EARTH_CELL_M !== 0) {
    throw new IngestError(
      'SurfaceBadWindow',
      `window size ${sizeM} is not a multiple of ${BARE_EARTH_CELL_M} m`,
    );
  }
  const centreEast = Math.min(
    (focus.minEast + focus.maxEast) / 2,
    DATA_EAST_EDGE_LOCAL_M - sizeM / 2,
  );
  const centreE = ORIGIN.easting + centreEast;
  const centreN = ORIGIN.northing + (focus.minNorth + focus.maxNorth) / 2;
  const snap = (v: number) => Math.floor(v / BARE_EARTH_CELL_M) * BARE_EARTH_CELL_M;
  const xmin = snap(centreE - sizeM / 2);
  const ymin = snap(centreN - sizeM / 2);
  const utm = { xmin, ymin, xmax: xmin + sizeM, ymax: ymin + sizeM };
  return {
    utm,
    local: {
      xmin: utm.xmin - ORIGIN.easting,
      ymin: utm.ymin - ORIGIN.northing,
      xmax: utm.xmax - ORIGIN.easting,
      ymax: utm.ymax - ORIGIN.northing,
    },
    ept3857: toEpt3857(utm),
  };
}

/** Throws when the EPSG:3857 box is not inside the dataset extent recorded in ept.json. */
export function assertInsideEptExtent(box: Box, e: Box = EPT_EXTENT_3857): void {
  if (box.xmin < e.xmin || box.xmax > e.xmax || box.ymin < e.ymin || box.ymax > e.ymax) {
    throw new IngestError(
      'SurfaceOutsideEpt',
      `window x ${box.xmin}..${box.xmax} y ${box.ymin}..${box.ymax} is outside the EPT extent x ${e.xmin}..${e.xmax} y ${e.ymin}..${e.ymax}`,
    );
  }
}

export interface SquareWindow {
  utm: Box;
  /** Envelope of the square in EPSG:3857. */
  ept3857: Box;
  /** Western reader: MN_LakeSuperior_2_2021 up to the end of its extent. */
  boundsWest: Box;
  /** Eastern reader: MN_LakeSuperior_1_2021 from the seam eastward. The two overlap, and the writer keeps the max per cell. */
  boundsEast: Box;
}

/** The whole terrain square, with the per-dataset EPSG:3857 read bounds; both are asserted to lie inside their dataset. */
export function computeSquareWindow(): SquareWindow {
  const utm: Box = { ...SQUARE_UTM };
  const env = toEpt3857(utm);
  const boundsWest = { ...env, xmax: Math.min(env.xmax, EPT_EXTENT_3857.xmax) };
  const boundsEast = { ...env, xmin: Math.max(env.xmin, SEAM_X_3857) };
  assertInsideEptExtent(boundsWest);
  assertInsideEptExtent(boundsEast, EPT_EAST_EXTENT_3857);
  return { utm, ept3857: env, boundsWest, boundsEast };
}

const TEMPLATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'surface-pipeline.json',
);
export const SQUARE_TEMPLATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'surface-pipeline-square.json',
);
const PLACEHOLDER = /^\{\{([A-Z0-9_]+)\}\}$/;

/** Replaces every string exactly equal to {{NAME}} with the value for NAME (any JSON type); an unknown or unused name throws. */
export function resolvePipeline(
  template: unknown,
  values: Record<string, string | number>,
): z.infer<typeof ResolvedPipelineSchema> {
  const used = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const m = PLACEHOLDER.exec(node);
      if (m === null) return node;
      const key = m[1] as string;
      if (!(key in values)) throw new IngestError('SurfaceBadTemplate', `no value for {{${key}}}`);
      used.add(key);
      return values[key];
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  const resolved = ResolvedPipelineSchema.parse(walk(template));
  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length > 0) {
    throw new IngestError(
      'SurfaceBadTemplate',
      `values not used by the template: ${unused.join(', ')}`,
    );
  }
  return resolved;
}

const StatsSchema = z.looseObject({
  statistic: z.array(
    z.looseObject({
      name: z.string(),
      count: z.number(),
      minimum: z.number(),
      maximum: z.number(),
    }),
  ),
});
const MetadataSchema = z.looseObject({
  stages: z.looseObject({ 'filters.stats': z.array(StatsSchema).length(2) }),
});

/** Reads the two filters.stats stages (after the reader, then after the first-return filter) from `pdal pipeline --metadata`. */
export function parsePointCounts(metadata: unknown): { pointsRead: number; firstReturns: number } {
  const [read, first] = MetadataSchema.parse(metadata).stages['filters.stats'];
  const pick = (s: z.infer<typeof StatsSchema> | undefined, label: string) => {
    const stat = s?.statistic.find((x) => x.name === 'ReturnNumber');
    if (stat === undefined)
      throw new IngestError('SurfaceBadMetadata', `no ReturnNumber stats for ${label}`);
    return stat;
  };
  const r = pick(read, 'read');
  const f = pick(first, 'first');
  if (f.maximum !== 1 || f.minimum !== 1) {
    throw new IngestError(
      'SurfaceBadMetadata',
      'the first-return stage kept a return number other than 1',
    );
  }
  return { pointsRead: r.count, firstReturns: f.count };
}

type ProgressFactory = (job: string, opts: ProgressOptions) => Progress;
const noopProgress: ProgressFactory = () => ({ tick() {}, done() {} });

function pdalVersion(): string {
  const out = execFileSync('pdal', ['--version'], { encoding: 'utf8' });
  const m = /pdal\s+(\d+\.\d+\.\d+)/.exec(out);
  if (m === null) throw new IngestError('SurfacePdalMissing', `cannot read a version from: ${out}`);
  return m[1] as string;
}

/** Runs `pdal pipeline`, ticking the heartbeat every 5 s, and resolves with the parsed --metadata file. */
function runPdal(pipelineFile: string, metadataFile: string, p: Progress): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('pdal', ['pipeline', pipelineFile, '--metadata', metadataFile], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const started = performance.now();
    const beat = setInterval(
      () =>
        p.tick(0, { phase: 'pdal', elapsedS: Math.round((performance.now() - started) / 1000) }),
      5000,
    );
    child.on('error', (err) => {
      clearInterval(beat);
      reject(new IngestError('SurfacePdalMissing', `cannot start pdal: ${err.message}`));
    });
    child.on('close', (code) => {
      clearInterval(beat);
      if (code !== 0) {
        reject(new IngestError('SurfacePdalFailed', `pdal exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(readFileSync(metadataFile, 'utf8')));
    });
  });
}

function writeAtomic(file: string, data: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface SurfaceRunOptions {
  force?: boolean;
  /** Which window to pin: the 2.5 km resort core (default) or the whole terrain square. */
  window?: SurfaceWindowName;
  /** Core window edge in metres; tests and the trial run pass a small one. */
  sizeM?: number;
  dataDir?: string;
  progressDir?: string;
  progressFactory?: ProgressFactory;
}

const boundsText = (b: Box) => `([${b.xmin},${b.xmax}],[${b.ymin},${b.ymax}])`;

/** File names, window and pipeline inputs for one window. */
export function planFor(windowName: SurfaceWindowName, sizeM: number = WINDOW_SIZE_M) {
  if (windowName === 'core') {
    const w = computeSurfaceWindow(sizeM);
    assertInsideEptExtent(w.ept3857);
    return {
      name: 'surface-core' as const,
      tif: 'surface-core.tif',
      manifest: 'surface-manifest.json',
      pipeline: 'surface-pipeline.resolved.json',
      templateFile: TEMPLATE_FILE,
      utm: w.utm,
      ept3857: w.ept3857,
      resolutions: [1, 2] as const,
      extraEptUrls: [] as string[],
      readerValues: { EPT_URL, BOUNDS_3857: boundsText(w.ept3857) } as Record<string, string>,
    };
  }
  const w = computeSquareWindow();
  return {
    name: 'surface-square' as const,
    tif: 'surface-square.tif',
    manifest: 'surface-square-manifest.json',
    pipeline: 'surface-square-pipeline.resolved.json',
    templateFile: SQUARE_TEMPLATE_FILE,
    utm: w.utm,
    ept3857: w.ept3857,
    resolutions: [2, 4] as const,
    extraEptUrls: [EPT_URL_EAST],
    readerValues: {
      EPT_URL_WEST: EPT_URL,
      BOUNDS_WEST: boundsText(w.boundsWest),
      EPT_URL_EAST,
      BOUNDS_EAST: boundsText(w.boundsEast),
    } as Record<string, string>,
  };
}

/** Computes the window, runs PDAL (retrying at the coarser resolution if the raster is over the size cap), and writes the raster, resolved pipeline and manifest. */
export async function runSurface(opts: SurfaceRunOptions = {}): Promise<SurfaceManifest> {
  const {
    force = false,
    window: windowName = 'core',
    sizeM = WINDOW_SIZE_M,
    dataDir = path.join(REPO_ROOT, 'data'),
    progressDir = 'reports/.progress',
    progressFactory = noopProgress,
  } = opts;
  const plan = planFor(windowName, sizeM);
  const rawDir = path.join(dataDir, 'raw');
  const tifFile = path.join(rawDir, plan.tif);
  const manifestFile = path.join(rawDir, plan.manifest);
  const pipelineFile = path.join(rawDir, plan.pipeline);
  const metadataFile = path.join(rawDir, `${plan.name}-pdal-metadata.tmp.json`);
  const pinned = [tifFile, manifestFile, pipelineFile].filter((f) => existsSync(f));
  if (pinned.length > 0 && !force) {
    throw new IngestError('AlreadyPinned', `${pinned.join(', ')} exist; pass --force to supersede`);
  }

  const version = pdalVersion();
  const template: unknown = JSON.parse(readFileSync(plan.templateFile, 'utf8'));
  const p = progressFactory(`ingest-${plan.name}`, { dir: progressDir, total: 1, everyN: 1 });
  mkdirSync(rawDir, { recursive: true });
  const rel = path.relative(REPO_ROOT, tifFile);
  const outputTif = rel.startsWith('..') ? tifFile : rel;
  const spanX = plan.utm.xmax - plan.utm.xmin;
  const spanY = plan.utm.ymax - plan.utm.ymin;

  const attempt = async (resolutionM: number) => {
    const resolved = resolvePipeline(template, {
      ...plan.readerValues,
      OUTPUT_TIF: outputTif,
      RESOLUTION: resolutionM,
      ORIGIN_X: plan.utm.xmin,
      ORIGIN_Y: plan.utm.ymin,
      WIDTH: Math.ceil(spanX / resolutionM),
      HEIGHT: Math.ceil(spanY / resolutionM),
    });
    writeAtomic(pipelineFile, `${JSON.stringify(resolved, null, 2)}\n`);
    rmSync(tifFile, { force: true });
    const started = performance.now();
    // PDAL resolves a relative filename against its cwd, so it runs from the repo root.
    // EPT reads hit thousands of small S3 objects; one failed GET aborts PDAL, so a failed run is retried.
    let metadata: unknown;
    for (let tries = 1; ; tries += 1) {
      try {
        metadata = await runPdal(pipelineFile, metadataFile, p);
        break;
      } catch (err) {
        const retry =
          err instanceof IngestError &&
          err.code === 'SurfacePdalFailed' &&
          /Could not read|curl|connection|timed out/i.test(err.message) &&
          tries < PDAL_TRIES;
        if (!retry) throw err;
        p.tick(0, { phase: 'pdal-retry', tries });
      }
    }
    const seconds = (performance.now() - started) / 1000;
    rmSync(metadataFile, { force: true });
    return { resolved, metadata, seconds, bytes: statSync(tifFile).size };
  };

  let resolutionM: number = plan.resolutions[0];
  let first = await attempt(resolutionM);
  let firstAttemptBytes: number | null = null;
  if (first.bytes > MAX_RASTER_BYTES) {
    firstAttemptBytes = first.bytes;
    resolutionM = plan.resolutions[1];
    first = await attempt(resolutionM);
  }
  const tif = readFileSync(tifFile);
  const counts = parsePointCounts(first.metadata);
  const manifest = SurfaceManifestSchema.parse({
    version: 1,
    name: plan.name,
    path: `data/raw/${plan.tif}`,
    eptUrl: EPT_URL,
    ...(plan.extraEptUrls.length > 0 ? { extraEptUrls: plan.extraEptUrls } : {}),
    pdalVersion: version,
    pipeline: first.resolved,
    epsg: 26915,
    window26915: plan.utm,
    window3857: plan.ept3857,
    resolutionM,
    width: Math.ceil(spanX / resolutionM),
    height: Math.ceil(spanY / resolutionM),
    pointsRead: counts.pointsRead,
    firstReturnsKept: counts.firstReturns,
    byteLength: tif.byteLength,
    sha256: sha256Hex(tif),
    seconds: Math.round(first.seconds * 10) / 10,
    fetchedAt: new Date(performance.timeOrigin + performance.now()).toISOString(),
    firstAttemptBytes,
  });
  writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ bytes: tif.byteLength, pointsRead: counts.pointsRead });
  return manifest;
}

async function main() {
  const { values } = parseArgs({
    options: {
      force: { type: 'boolean', default: false },
      window: { type: 'string', default: 'core' },
      'size-m': { type: 'string' },
      'data-dir': { type: 'string' },
    },
  });
  let progressFactory: ProgressFactory = noopProgress;
  try {
    const helper = await import('/Users/graham/.claude/lib/progress.mjs');
    progressFactory = helper.progress;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.error('heartbeat disabled: helper absent');
  }
  try {
    const windowName = z.enum(SURFACE_WINDOWS).parse(values.window);
    const dataDir = values['data-dir'];
    const sizeM = values['size-m'];
    const m = await runSurface({
      force: values.force,
      window: windowName,
      progressFactory,
      ...(sizeM === undefined ? {} : { sizeM: Number(sizeM) }),
      ...(dataDir === undefined ? {} : { dataDir: path.resolve(dataDir) }),
    });
    console.log(
      `pinned surface ${m.width}x${m.height} @ ${m.resolutionM} m, ${m.byteLength} bytes, ${m.pointsRead} points read, ${m.firstReturnsKept} first returns, ${m.seconds} s`,
    );
    console.log(
      `window 26915 ${JSON.stringify(m.window26915)} 3857 ${JSON.stringify(m.window3857)}`,
    );
  } catch (err) {
    console.error(err instanceof IngestError ? err.message : err);
    process.exit(err instanceof IngestError && err.code === 'AlreadyPinned' ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

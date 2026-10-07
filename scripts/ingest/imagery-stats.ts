import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decode } from 'jpeg-js';
import { z } from 'zod';
import { ImageryStatsSchema, type ImageryStats } from '../../src/schema/imagery-stats';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { ImageryManifestSchema } from './imagery-manifest-schema';
import { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/imagery-stats.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/imagery-manifest-schema.ts',
  'scripts/ingest/imagery-stats.ts',
  'scripts/ingest/replay.ts',
  'src/schema/imagery-stats.ts',
  'src/schema/replay.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['jpeg-js', 'zod'];

export const STATS_NAME = 'imagery-stats.json';
export const STATS_REPLAY_NAME = 'imagery-stats.replay.json';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Imagery stats replay schema
 * @strategicPurpose Extends the shared replay base with the decoder version and lockfile subtree hash, so the mean colour is provably reproducible from the pinned JPEG.
 * @tacticalObjective Validates the base record (effect reduces) plus toolVersions (jpeg-js only) and lockSubtreeSha256 before data/imagery-stats.replay.json is written.
 */
export const ImageryStatsReplaySchema = ReplayRecordSchema.extend({
  toolVersions: z.strictObject({ 'jpeg-js': z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
});
export type ImageryStatsReplay = z.infer<typeof ImageryStatsReplaySchema>;

export class ImageryStatsError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

/** The standard sRGB electro-optical transfer function, input and output in 0-1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const round = (v: number, digits: number): number => Number(v.toFixed(digits));

export interface StatsSource {
  path: string;
  sha256: string;
}

/**
 * @displayName Compute imagery mean colour
 * @strategicPurpose Reduces the pinned NAIP orthoimage to the one ground colour the scene paints beyond the faded tiles, once at ingest and never in the browser.
 * @tacticalObjective Decodes the JPEG with jpeg-js, averages R, G, B over every pixel in sRGB 0-255 and in linear light 0-1 (per-pixel conversion through a 256-entry table, exact integer histograms), and returns an ImageryStats that passed ImageryStatsSchema.safeParse.
 * @manipulation reduces
 */
export function computeImageryStats(jpeg: Uint8Array, source: StatsSource): ImageryStats {
  const image = decode(jpeg, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  const pixelCount = image.width * image.height;
  // Integer histograms keep the sums exact, so the result does not depend on accumulation order.
  const hr = new Float64Array(256);
  const hg = new Float64Array(256);
  const hb = new Float64Array(256);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    hr[data[i] as number] = (hr[data[i] as number] as number) + 1;
    hg[data[i + 1] as number] = (hg[data[i + 1] as number] as number) + 1;
    hb[data[i + 2] as number] = (hb[data[i + 2] as number] as number) + 1;
  }
  const lut = Array.from({ length: 256 }, (_, v) => srgbToLinear(v / 255));
  const mean = (h: Float64Array, value: (v: number) => number): number => {
    let sum = 0;
    for (let v = 0; v < 256; v += 1) sum += (h[v] as number) * value(v);
    return sum / pixelCount;
  };
  const srgb = (h: Float64Array) =>
    round(
      mean(h, (v) => v),
      6,
    );
  const lin = (h: Float64Array) =>
    round(
      mean(h, (v) => lut[v] as number),
      8,
    );
  const candidate = {
    version: 1,
    source,
    width: image.width,
    height: image.height,
    pixelCount,
    meanSrgb255: { r: srgb(hr), g: srgb(hg), b: srgb(hb) },
    meanLinear: { r: lin(hr), g: lin(hg), b: lin(hb) },
  };
  const gate = ImageryStatsSchema.safeParse(candidate);
  if (!gate.success) throw new ImageryStatsError('StatsInvalid', gate.error.message);
  return gate.data;
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

function jpegJsVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = z
    .looseObject({ devDependencies: z.record(z.string(), z.string()) })
    .safeParse(JSON.parse(text));
  const version = parsed.success ? parsed.data.devDependencies['jpeg-js'] : undefined;
  if (version === undefined) {
    throw new ImageryStatsError('BadPackage', 'package.json has no jpeg-js devDependency');
  }
  return version;
}

export interface ImageryStatsOptions {
  dataDir: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

/** Verifies the pinned JPEG against its manifest, computes the stats, then writes the stats file and the replay sidecar last. */
export function runImageryStats(options: ImageryStatsOptions): {
  stats: ImageryStats;
  replay: ImageryStatsReplay;
} {
  const manifestParsed = ImageryManifestSchema.safeParse(
    JSON.parse(readFileSync(join(options.dataDir, 'raw', 'imagery-manifest.json'), 'utf8')),
  );
  if (!manifestParsed.success) {
    throw new ImageryStatsError('ManifestInvalid', manifestParsed.error.message);
  }
  const manifest = manifestParsed.data;
  const jpeg = readFileSync(join(options.dataDir, 'raw', 'naip.jpg'));
  const inputSha256 = sha256Hex(jpeg);
  if (inputSha256 !== manifest.sha256) {
    throw new ImageryStatsError(
      'PinnedInputHashMismatch',
      `naip.jpg sha256 ${inputSha256} differs from the manifest pin ${manifest.sha256}`,
    );
  }
  const stats = computeImageryStats(jpeg, { path: manifest.path, sha256: inputSha256 });
  if (stats.width !== manifest.width || stats.height !== manifest.height) {
    throw new ImageryStatsError(
      'ManifestDimensionMismatch',
      `JPEG is ${stats.width}x${stats.height}, manifest says ${manifest.width}x${manifest.height}`,
    );
  }
  const statsText = `${JSON.stringify(stats, null, 2)}\n`;
  const replayParsed = ImageryStatsReplaySchema.safeParse({
    inputHash: inputSha256,
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(statsText),
    effect: 'reduces',
    toolVersions: { 'jpeg-js': jpegJsVersion() },
    lockSubtreeSha256: options.lockSubtree,
  });
  if (!replayParsed.success)
    throw new ImageryStatsError('ReplayInvalid', replayParsed.error.message);
  const replay = replayParsed.data;
  mkdirSync(options.dataDir, { recursive: true });
  writeAtomic(join(options.dataDir, STATS_NAME), statsText);
  writeAtomic(join(options.dataDir, STATS_REPLAY_NAME), `${JSON.stringify(replay, null, 2)}\n`);
  return { stats, replay };
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'allow-dirty': { type: 'boolean', default: false },
    },
  });
  const allowDirty = values['allow-dirty'] === true;
  const started = performance.now();
  const { stats } = runImageryStats({
    dataDir: values['data-dir'] ?? 'data',
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty }),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const m = stats.meanSrgb255;
  const l = stats.meanLinear;
  process.stdout.write(
    `ingest:imagery-stats ok ${stats.pixelCount} px, sRGB ${m.r} ${m.g} ${m.b}, linear ${l.r} ${l.g} ${l.b}, ${seconds} s\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

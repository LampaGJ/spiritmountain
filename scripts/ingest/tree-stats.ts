import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TreeStatsSchema, type TreeStats } from '../../src/schema/tree-stats';
import { ContextTreesHeaderSchema } from './context-trees-schema';
import { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';
import { TREE_RECORD_BYTES, TreesHeaderSchema, unpackTrees, type TreeRecord } from './trees-schema';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/tree-stats.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/context-trees-schema.ts',
  'scripts/ingest/replay.ts',
  'scripts/ingest/tree-stats.ts',
  'scripts/ingest/trees-schema.ts',
  'src/schema/replay.ts',
  'src/schema/tree-stats.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['zod'];

export const STATS_NAME = 'tree-stats.json';
export const STATS_REPLAY_NAME = 'tree-stats.replay.json';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Tree stats replay schema
 * @strategicPurpose Extends the shared replay base with the lockfile subtree hash, so the mean tree colour is provably reproducible from the pinned tree files.
 * @tacticalObjective Validates the base record (effect reduces) plus lockSubtreeSha256 before data/tree-stats.replay.json is written.
 */
export const TreeStatsReplaySchema = ReplayRecordSchema.extend({
  lockSubtreeSha256: Sha256Schema,
});
export type TreeStatsReplay = z.infer<typeof TreeStatsReplaySchema>;

export class TreeStatsError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

/** The standard sRGB electro-optical transfer function, input and output in 0-1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The inverse transfer function: linear light 0-1 to sRGB 0-1. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

const round = (v: number, digits: number): number => Number(v.toFixed(digits));

export interface TreeStatsSource {
  path: string;
  sha256: string;
}

/**
 * @displayName Compute mean tree colour
 * @strategicPurpose Reduces every tree record (simulated core plus far-field context) to the one ground colour the scene paints beyond the faded tiles, once at ingest and never in the browser.
 * @tacticalObjective Converts each tree's sRGB colour to linear light, averages R, G, B with equal weight per tree in record order (a fixed accumulation order, so the result is byte-stable), and returns a TreeStats that passed TreeStatsSchema.safeParse. Throws on zero trees.
 * @manipulation reduces
 */
export function computeTreeStats(
  records: readonly TreeRecord[],
  sources: readonly TreeStatsSource[],
): TreeStats {
  if (records.length === 0) throw new TreeStatsError('NoTrees', 'no tree records to average');
  let r = 0;
  let g = 0;
  let b = 0;
  for (const t of records) {
    r += srgbToLinear(t.r);
    g += srgbToLinear(t.g);
    b += srgbToLinear(t.b);
  }
  const n = records.length;
  const lin = { r: round(r / n, 8), g: round(g / n, 8), b: round(b / n, 8) };
  const candidate = {
    version: 1,
    sources: [...sources],
    count: n,
    meanLinear: lin,
    meanSrgb: {
      r: round(linearToSrgb(lin.r), 8),
      g: round(linearToSrgb(lin.g), 8),
      b: round(linearToSrgb(lin.b), 8),
    },
  };
  const gate = TreeStatsSchema.safeParse(candidate);
  if (!gate.success) throw new TreeStatsError('StatsInvalid', gate.error.message);
  return gate.data;
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

export interface TreeStatsOptions {
  dataDir: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

/** Reads one tree file pair through its header schema, checks count and byte length, and returns the records and the pinned file hashes. */
function readTrees(
  dataDir: string,
  name: 'trees' | 'context-trees',
): { records: TreeRecord[]; sources: TreeStatsSource[] } {
  const headerText = readFileSync(join(dataDir, `${name}.json`), 'utf8');
  const schema = name === 'trees' ? TreesHeaderSchema : ContextTreesHeaderSchema;
  const parsed = schema.safeParse(JSON.parse(headerText));
  if (!parsed.success) {
    throw new TreeStatsError('HeaderInvalid', `${name}.json: ${parsed.error.message}`);
  }
  const header = parsed.data;
  const bin = readFileSync(join(dataDir, `${name}.bin`));
  if (bin.byteLength !== header.byteLength || bin.byteLength !== header.count * TREE_RECORD_BYTES) {
    throw new TreeStatsError(
      'BinLengthMismatch',
      `${name}.bin is ${bin.byteLength} bytes, header says ${header.byteLength}`,
    );
  }
  const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  return {
    records: unpackTrees(buffer as ArrayBuffer, header.count),
    sources: [
      { path: `data/${name}.bin`, sha256: sha256Hex(bin) },
      { path: `data/${name}.json`, sha256: sha256Hex(headerText) },
    ],
  };
}

/** Reads both tree files, computes the mean colour, then writes the stats file and the replay sidecar last. */
export function runTreeStats(options: TreeStatsOptions): {
  stats: TreeStats;
  replay: TreeStatsReplay;
} {
  const core = readTrees(options.dataDir, 'trees');
  const context = readTrees(options.dataDir, 'context-trees');
  const sources = [...core.sources, ...context.sources];
  const stats = computeTreeStats([...core.records, ...context.records], sources);
  const statsText = `${JSON.stringify(stats, null, 2)}\n`;
  const inputLines = sources.map((s) => `${s.path} ${s.sha256}\n`).join('');
  const replayParsed = TreeStatsReplaySchema.safeParse({
    inputHash: sha256Hex(inputLines),
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(statsText),
    effect: 'reduces',
    lockSubtreeSha256: options.lockSubtree,
  });
  if (!replayParsed.success) throw new TreeStatsError('ReplayInvalid', replayParsed.error.message);
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
      force: { type: 'boolean', default: false },
    },
  });
  if (values.force !== true) {
    throw new TreeStatsError(
      'RefusedOverwrite',
      'ingest:tree-stats rewrites data/tree-stats.*; pass --force to run it',
    );
  }
  const started = performance.now();
  const { stats } = runTreeStats({
    dataDir: values['data-dir'] ?? 'data',
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () =>
      resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty: values['allow-dirty'] === true }),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const s = stats.meanSrgb;
  const l = stats.meanLinear;
  process.stdout.write(
    `ingest:tree-stats ok ${stats.count} trees, sRGB ${s.r} ${s.g} ${s.b} (x255: ${(s.r * 255).toFixed(2)} ${(s.g * 255).toFixed(2)} ${(s.b * 255).toFixed(2)}), linear ${l.r} ${l.g} ${l.b}, ${seconds} s\n`,
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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../scripts/ingest/replay';
import {
  TRANSFORM_SOURCES,
  computeTreeStats,
  linearToSrgb,
  runTreeStats,
  srgbToLinear,
} from '../../scripts/ingest/tree-stats';
import { packTrees, type TreeRecord } from '../../scripts/ingest/trees-schema';
import { TreeStatsSchema } from '../../src/schema/tree-stats';

const tree = (r: number, g: number, b: number): TreeRecord => ({
  east: 0,
  north: 0,
  groundElev: 0,
  height: 10,
  type: 0,
  rotation: 0,
  r,
  g,
  b,
});
const source = [{ path: 'data/trees.bin', sha256: 'a'.repeat(64) }];

describe('tree-stats transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of tree-stats.ts', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles) {
        if (!fileName.startsWith('.') || fileName.endsWith('.json')) continue;
        const base = join(dirname(file), fileName);
        const found = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
        if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
        visit(relative('.', found));
      }
    };
    visit('scripts/ingest/tree-stats.ts');
    expect([...TRANSFORM_SOURCES].sort()).toEqual([...seen].sort());
  });
});

describe('computeTreeStats', () => {
  it('averages black and white trees in linear light, not in sRGB', () => {
    const stats = computeTreeStats([tree(0, 0, 0), tree(1, 1, 1)], source);
    expect(stats.count).toBe(2);
    for (const c of ['r', 'g', 'b'] as const) {
      expect(stats.meanLinear[c]).toBeCloseTo(0.5, 7);
      // The sRGB encoding of linear 0.5 is about 0.735, far from the plain sRGB mid-grey 0.5.
      expect(stats.meanSrgb[c]).toBeCloseTo(0.735357, 5);
    }
  });

  it('weights every tree equally regardless of position or size', () => {
    const big = { ...tree(0.2, 0.4, 0.1), height: 35 };
    const a = computeTreeStats([big, tree(0.2, 0.4, 0.1)], source);
    const b = computeTreeStats([tree(0.2, 0.4, 0.1)], source);
    expect(a.meanLinear).toEqual(b.meanLinear);
  });

  it('is byte-stable across runs and throws on zero trees', () => {
    const records = [tree(0.1, 0.3, 0.05), tree(0.2, 0.25, 0.1), tree(0.15, 0.35, 0.08)];
    expect(JSON.stringify(computeTreeStats(records, source))).toBe(
      JSON.stringify(computeTreeStats(records, source)),
    );
    expect(() => computeTreeStats([], source)).toThrow(/NoTrees/);
  });

  it('transfer functions hit the known anchors and invert each other', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
    expect(linearToSrgb(srgbToLinear(0.37))).toBeCloseTo(0.37, 12);
  });
});

describe('runTreeStats', () => {
  const header = (count: number, bytes: number) => ({
    version: 1,
    count,
    recordFloats: 9,
    byteOrder: 'LE',
    dtype: 'float32',
    fields: ['east', 'north', 'groundElev', 'height', 'type', 'rotation', 'r', 'g', 'b'],
    byteLength: bytes,
    types: { broadleaf: count, conifer: 0 },
    archetypes: [count, 0, 0, 0, 0, 0],
    frame: { file: 'data/frame.json', sha256: 'd'.repeat(64) },
    sources: [{ path: 'x', sha256: 'e'.repeat(64) }],
  });
  const treesHeader = (count: number, bytes: number) => ({
    ...header(count, bytes),
    params: JSON.parse(readFileSync('data/trees.json', 'utf8')).params as unknown,
    canopyCells: 0,
    nocanopyCellsReplaced: 0,
  });
  const contextHeader = (count: number, bytes: number) => ({
    ...header(count, bytes),
    params: JSON.parse(readFileSync('data/context-trees.json', 'utf8')).params as unknown,
    forestBlocks: 0,
  });
  const sandbox = (corrupt = false) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tree-stats-'));
    mkdirSync(dataDir, { recursive: true });
    const core = packTrees([tree(0, 0, 0), tree(1, 1, 1)]);
    const far = packTrees([tree(1, 1, 1)]);
    writeFileSync(join(dataDir, 'trees.bin'), core);
    writeFileSync(join(dataDir, 'context-trees.bin'), corrupt ? far.slice(0, 10) : far);
    writeFileSync(join(dataDir, 'trees.json'), JSON.stringify(treesHeader(2, core.length)));
    writeFileSync(
      join(dataDir, 'context-trees.json'),
      JSON.stringify(contextHeader(1, far.length)),
    );
    return dataDir;
  };
  const options = (dataDir: string) => ({
    dataDir,
    lockSubtree: 'b'.repeat(64),
    resolveCommit: () => 'c'.repeat(40),
  });

  it('writes stats over both files and a reduces replay whose outputHash matches the stats bytes', () => {
    const dataDir = sandbox();
    const { stats, replay } = runTreeStats(options(dataDir));
    const text = readFileSync(join(dataDir, 'tree-stats.json'), 'utf8');
    expect(TreeStatsSchema.parse(JSON.parse(text))).toEqual(stats);
    expect(stats.count).toBe(3);
    // One black and two white trees: linear mean 2/3.
    expect(stats.meanLinear.g).toBeCloseTo(2 / 3, 7);
    expect(stats.sources.map((s) => s.path)).toEqual([
      'data/trees.bin',
      'data/trees.json',
      'data/context-trees.bin',
      'data/context-trees.json',
    ]);
    expect(replay.effect).toBe('reduces');
    expect(replay.outputHash).toBe(sha256Hex(text));
    expect(existsSync(join(dataDir, 'tree-stats.replay.json'))).toBe(true);
  });

  it('replays byte-identically', () => {
    const dataDir = sandbox();
    runTreeStats(options(dataDir));
    const first = readFileSync(join(dataDir, 'tree-stats.json'), 'utf8');
    const firstReplay = readFileSync(join(dataDir, 'tree-stats.replay.json'), 'utf8');
    runTreeStats(options(dataDir));
    expect(readFileSync(join(dataDir, 'tree-stats.json'), 'utf8')).toBe(first);
    expect(readFileSync(join(dataDir, 'tree-stats.replay.json'), 'utf8')).toBe(firstReplay);
  });

  it('refuses a bin whose length differs from its header', () => {
    expect(() => runTreeStats(options(sandbox(true)))).toThrow(/BinLengthMismatch/);
  });
});

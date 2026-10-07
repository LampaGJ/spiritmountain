import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { CONTEXT_TILES, tileKey } from '../../scripts/ingest/context-tiles';
import {
  ContextReplaySchema,
  TRANSFORM_SOURCES,
  runContextTerrain,
} from '../../scripts/ingest/context-terrain';
import { sha256Hex } from '../../scripts/ingest/replay';
import { readFrame } from '../../scripts/ingest/terrain-deps';

const pinned = existsSync('data/raw/context/manifest.json');

describe('context-terrain transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of context-terrain.ts', () => {
    const closure = (entry: string): string[] => {
      const seen = new Set<string>();
      const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
          .importedFiles) {
          if (!fileName.startsWith('.') || fileName.endsWith('.json')) continue;
          const base = join(dirname(file), fileName);
          const found = [`${base}.ts`, join(base, 'index.ts')].find((candidate) =>
            existsSync(candidate),
          );
          if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
          visit(relative('.', found));
        }
      };
      visit(entry);
      return [...seen].sort();
    };
    expect([...TRANSFORM_SOURCES].sort()).toEqual(closure('scripts/ingest/context-terrain.ts'));
  });
});

describe.skipIf(!pinned)('context terrain on the pinned tiles', () => {
  const frameBytes = readFileSync('data/frame.json');
  const options = (dataDir: string) => ({
    dataDir,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: 'c'.repeat(64),
    resolveCommit: () => 'd'.repeat(40),
  });
  const stage = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-'));
    mkdirSync(join(dir, 'raw', 'context'), { recursive: true });
    for (const name of readdirSync('data/raw/context')) {
      if (name.endsWith('.tif') || name === 'manifest.json') {
        copyFileSync(join('data/raw/context', name), join(dir, 'raw', 'context', name));
      }
    }
    return dir;
  };

  it('writes 12 header and heightfield pairs, byte-identical on a second run', async () => {
    const dir = stage();
    const first = await runContextTerrain(options(dir));
    const read = () =>
      readdirSync(join(dir, 'context'))
        .sort()
        .map((n) => `${n} ${sha256Hex(readFileSync(join(dir, 'context', n)))}`);
    const a = read();
    const second = await runContextTerrain(options(dir));
    expect(read()).toEqual(a);
    expect(second.replay).toEqual(first.replay);
    expect(a).toHaveLength(25);
    expect(first.headers).toHaveLength(12);
    ContextReplaySchema.parse(first.replay);
  });

  it('matches the committed output and parses each header', async () => {
    const dir = stage();
    await runContextTerrain(options(dir));
    for (const [i, j] of CONTEXT_TILES) {
      const key = tileKey(i, j);
      for (const ext of ['f32', 'json']) {
        expect(
          readFileSync(join(dir, 'context', `${key}.${ext}`)).equals(
            readFileSync(`data/context/${key}.${ext}`),
          ),
        ).toBe(true);
      }
      const header = TerrainHeaderSchema.parse(
        JSON.parse(readFileSync(`data/context/${key}.json`, 'utf8')),
      );
      expect(header.width).toBe(232);
      expect(header.height).toBe(225);
      expect(header.source.path).toBe(`data/raw/context/${key}.tif`);
      expect(header.nodataFilled).toBe(0);
    }
  });
});

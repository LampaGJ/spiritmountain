import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../scripts/ingest/annotations';
import { sha256Hex } from '../../scripts/ingest/replay';
import { annotationsFileForAreas } from '../../src/schema/annotations-file';
import { ReplayRecordSchema } from '../../src/schema/replay';
import {
  AREA_ROWS,
  FAKE_COMMIT,
  SEED_PATH,
  areasBytes,
  bytesOf,
  realSeedRows,
} from './annotations-fixtures';

let dir: string;
let areasPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'annotations-'));
  areasPath = join(dir, 'areas.geojson');
  writeFileSync(areasPath, areasBytes());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  extra: string[],
  opts: { out?: string; resolveCommit?: (allowDirty: boolean) => string } = {},
) {
  const outDir = opts.out ?? join(dir, 'out');
  let stdout = '';
  let stderr = '';
  const status = await main(
    ['--out', outDir, '--areas', areasPath, '--seed', SEED_PATH, ...extra],
    {
      resolveCommit: opts.resolveCommit ?? (() => FAKE_COMMIT),
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
    },
  );
  return { status, stdout, stderr, outDir };
}

const read = (path: string) => readFileSync(path, 'utf8');

describe('first run', () => {
  it('exits 0, writes both files, and the file passes the areas-aware schema', async () => {
    const { status, outDir } = await run([]);
    expect(status).toBe(0);
    expect(readdirSync(outDir).sort()).toEqual(['annotations.json', 'annotations.replay.json']);
    const file: unknown = JSON.parse(read(join(outDir, 'annotations.json')));
    expect(
      annotationsFileForAreas(new Set(AREA_ROWS.map((r) => r.id))).safeParse(file).success,
    ).toBe(true);
    const replay = ReplayRecordSchema.parse(
      JSON.parse(read(join(outDir, 'annotations.replay.json'))),
    );
    expect(replay.outputHash).toBe(sha256Hex(read(join(outDir, 'annotations.json'))));
  });
  it('is byte-identical across two fresh directories', async () => {
    const a = await run([], { out: join(dir, 'a') });
    const b = await run([], { out: join(dir, 'b') });
    for (const name of ['annotations.json', 'annotations.replay.json']) {
      expect(read(join(a.outDir, name))).toBe(read(join(b.outDir, name)));
    }
  });
});

describe('canonical JSON', () => {
  it('writes no integer-like object key in either output (a JSON writer would reorder it)', async () => {
    const keysOf = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(keysOf)
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)])
          : [];
    expect(keysOf({ 2: 'x' })).toEqual(['2']); // positive control: the instrument sees integer-like keys
    const { outDir } = await run([]);
    for (const name of ['annotations.json', 'annotations.replay.json']) {
      const keys = keysOf(JSON.parse(read(join(outDir, name))));
      expect(keys.length).toBeGreaterThan(0);
      expect(
        keys.filter((key) => /^\d+$/.test(key)),
        name,
      ).toEqual([]);
    }
  });
});

describe('the overwrite guard', () => {
  it('refuses a second run with exit 2 and AnnotationsExist, and changes nothing', async () => {
    const first = await run([]);
    const before = read(join(first.outDir, 'annotations.json'));
    const second = await run([]);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('AnnotationsExist');
    expect(read(join(first.outDir, 'annotations.json'))).toBe(before);
    expect(readdirSync(first.outDir).sort()).toEqual([
      'annotations.json',
      'annotations.replay.json',
    ]);
  });
  it('treats a zero-byte file as existing', async () => {
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'annotations.json'), '');
    expect((await run([])).status).toBe(2);
    expect(read(join(out, 'annotations.json'))).toBe('');
  });
  it('treats a dangling symlink as existing, and --force refuses it with a different named error', async () => {
    const out = join(dir, 'out');
    mkdirSync(out);
    symlinkSync(join(dir, 'nowhere'), join(out, 'annotations.json'));
    expect((await run([])).status).toBe(2);
    const forced = await run(['--force']);
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain('AnnotationsTargetNotFile');
  });
  it('treats a directory as existing, and --force refuses it', async () => {
    const out = join(dir, 'out');
    mkdirSync(join(out, 'annotations.json'), { recursive: true });
    expect((await run([])).status).toBe(2);
    const forced = await run(['--force']);
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain('AnnotationsTargetNotFile');
  });
  it('--force backs up the previous bytes under a content-addressed name, then replaces the file and the replay', async () => {
    const out = join(dir, 'out');
    await run([]);
    const edited = '{"hand":"edited"}\n';
    writeFileSync(join(out, 'annotations.json'), edited);
    const forced = await run(['--force']);
    expect(forced.status).toBe(0);
    const backup = join(out, `annotations.${sha256Hex(edited).slice(0, 12)}.bak.json`);
    expect(read(backup)).toBe(edited);
    expect(forced.stdout).toContain(backup);
    expect(read(join(out, 'annotations.json'))).not.toBe(edited);
    const replay = ReplayRecordSchema.parse(JSON.parse(read(join(out, 'annotations.replay.json'))));
    expect(replay.outputHash).toBe(sha256Hex(read(join(out, 'annotations.json'))));
  });
  it('--force twice over identical content leaves exactly one backup', async () => {
    const out = join(dir, 'out');
    await run([]);
    expect((await run(['--force'])).status).toBe(0);
    expect((await run(['--force'])).status).toBe(0);
    expect(readdirSync(out).filter((name) => name.endsWith('.bak.json')).length).toBe(1);
  });
  it('an existing backup with different bytes is a BackupConflict and nothing is replaced', async () => {
    const out = join(dir, 'out');
    await run([]);
    const edited = '{"hand":"edited"}\n';
    writeFileSync(join(out, 'annotations.json'), edited);
    writeFileSync(
      join(out, `annotations.${sha256Hex(edited).slice(0, 12)}.bak.json`),
      'something else',
    );
    const forced = await run(['--force']);
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain('BackupConflict');
    expect(read(join(out, 'annotations.json'))).toBe(edited);
  });
  it('a stale replay file alone does not block a run, and is replaced', async () => {
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'annotations.replay.json'), 'stale');
    expect((await run([])).status).toBe(0);
    const replay = ReplayRecordSchema.parse(JSON.parse(read(join(out, 'annotations.replay.json'))));
    expect(replay.outputHash).toBe(sha256Hex(read(join(out, 'annotations.json'))));
  });
  it('leaves no temp file behind', async () => {
    const { outDir } = await run([]);
    expect(readdirSync(outDir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('named failures exit 1 and write nothing', () => {
  const rows = realSeedRows();
  async function expectFailure(args: string[], name: string, opts: Parameters<typeof run>[1] = {}) {
    const result = await run(args, opts);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(() => readdirSync(result.outDir)).not.toThrow();
    expect(readdirSync(result.outDir)).toEqual([]);
  }
  it('a seed with a renamed key names the field', async () => {
    const seed = join(dir, 'seed.json');
    writeFileSync(
      seed,
      JSON.stringify(rows.map(({ verified, ...rest }) => ({ ...rest, verifed: verified }))),
    );
    mkdirSync(join(dir, 'out'));
    const result = await run(['--seed', seed]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SeedInvalid');
    expect(result.stderr).toContain('verifed');
    expect(readdirSync(result.outDir)).toEqual([]);
  });
  it('a seed with a duplicated id is DuplicateOrgId', async () => {
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, JSON.stringify([...rows, rows[0]]));
    mkdirSync(join(dir, 'out'));
    await expectFailure(['--seed', seed], 'DuplicateOrgId');
  });
  it('an empty seed is NoOrganizations and an empty areas file is NoAreas', async () => {
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, '[]');
    mkdirSync(join(dir, 'out'));
    await expectFailure(['--seed', seed], 'NoOrganizations');
    writeFileSync(areasPath, bytesOf({ type: 'FeatureCollection', features: [] }));
    await expectFailure([], 'NoAreas');
  });
  it('a missing input file is InputMissing', async () => {
    mkdirSync(join(dir, 'out'));
    await expectFailure(['--areas', join(dir, 'nope.geojson')], 'InputMissing');
  });
  it('a dirty transform source is reported by name, and --allow-dirty reaches the resolver', async () => {
    mkdirSync(join(dir, 'out'));
    const dirty = () => {
      const error = new Error('uncommitted changes in a transform source');
      error.name = 'DirtyTransformSource';
      throw error;
    };
    await expectFailure([], 'DirtyTransformSource', { resolveCommit: dirty });
    const seen: boolean[] = [];
    const result = await run(['--allow-dirty'], {
      resolveCommit: (allowDirty) => (seen.push(allowDirty), FAKE_COMMIT),
    });
    expect(result.status).toBe(0);
    expect(seen).toEqual([true]);
    expect(result.stderr).toContain('--allow-dirty');
  });
  it('rethrows an unnamed Error from the resolver as itself instead of relabelling it NoCodeCommit', async () => {
    mkdirSync(join(dir, 'out'));
    const unnamed = () => {
      throw new Error('boom');
    };
    await expect(run([], { resolveCommit: unnamed })).rejects.toThrow('boom');
  });
  it('an unknown flag is BadArguments', async () => {
    mkdirSync(join(dir, 'out'));
    await expectFailure(['--bogus'], 'BadArguments');
  });
});

describe('the real CLI in a child process', () => {
  const helper = 'tests/ingest/helpers/run-annotations.ts';
  const spawn = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', helper, '--areas', areasPath, '--out', join(dir, 'cli-out'), ...args],
      { encoding: 'utf8' },
    );
  it('exits 0, then 2 with AnnotationsExist and unchanged bytes, then 1 for a bad seed', () => {
    const first = spawn([]);
    expect(first.status).toBe(0);
    const target = join(dir, 'cli-out', 'annotations.json');
    const before = read(target);
    const second = spawn([]);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('AnnotationsExist');
    expect(read(target)).toBe(before);
    const badSeed = join(dir, 'bad-seed.json');
    writeFileSync(badSeed, '[{"id":"x"}]');
    const third = spawn(['--force', '--seed', badSeed]);
    expect(third.status).toBe(1);
    expect(third.stderr).toContain('SeedInvalid');
    expect(read(target)).toBe(before);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReplayRecordSchema } from '../../src/schema/replay';
import {
  DirtyTransformSource,
  LOCKFILE_URL,
  NoCodeCommit,
  lockSubtreeSha256,
  resolveCodeCommit,
  sha256Hex,
} from '../../scripts/ingest/replay';

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-'));
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const write = (name: string, body: string) => writeFileSync(path.join(dir, name), body);
  const commit = (name: string, body: string) => {
    write(name, body);
    sh('add', name);
    sh('commit', '-m', `change ${name}`);
    return sh('rev-parse', 'HEAD');
  };
  sh('init');
  return { dir, sh, write, commit };
}

describe('scripts/ingest/replay helpers', () => {
  it('sha256Hex matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns the last commit touching the sources, and ReplayRecordSchema accepts it as codeCommit', () => {
    const r = repo();
    const c1 = r.commit('a.txt', 'one');
    const got = resolveCodeCommit(['a.txt'], { cwd: r.dir });
    expect(got).toBe(c1);
    expect(ReplayRecordSchema.shape.codeCommit.safeParse(got).success).toBe(true);
  });

  it('a commit touching an unrelated file does not change the result', () => {
    const r = repo();
    const c1 = r.commit('a.txt', 'one');
    const head2 = r.commit('output.json', '{}');
    expect(head2).not.toBe(c1);
    expect(resolveCodeCommit(['a.txt'], { cwd: r.dir })).toBe(c1);
  });

  it('a commit touching a source changes the result', () => {
    const r = repo();
    const c1 = r.commit('a.txt', 'one');
    const c2 = r.commit('a.txt', 'two');
    expect(c2).not.toBe(c1);
    expect(resolveCodeCommit(['a.txt'], { cwd: r.dir })).toBe(c2);
  });

  it('refuses a dirty source path unless allowDirty', () => {
    const r = repo();
    const c1 = r.commit('a.txt', 'one');
    r.write('a.txt', 'two');
    expect(() => resolveCodeCommit(['a.txt'], { cwd: r.dir })).toThrow(/uncommitted/);
    expect(resolveCodeCommit(['a.txt'], { cwd: r.dir, allowDirty: true })).toBe(c1);
  });

  it('errors when the sources are not committed yet, and when sourcePaths is empty', () => {
    const r = repo();
    r.commit('other.txt', 'x');
    r.write('new.txt', 'y');
    expect(() => resolveCodeCommit(['new.txt'], { cwd: r.dir, allowDirty: true })).toThrow(
      /no commit touches/,
    );
    expect(() => resolveCodeCommit([], { cwd: r.dir })).toThrow(/empty/);
  });

  it('exports both named errors with name exactly DirtyTransformSource and NoCodeCommit', () => {
    expect(new DirtyTransformSource('x').name).toBe('DirtyTransformSource');
    expect(new NoCodeCommit('x').name).toBe('NoCodeCommit');
  });

  it('the real resolveCodeCommit throws those names in a temp git repo', () => {
    const r = repo();
    r.commit('a.txt', 'one');
    r.write('a.txt', 'two');
    r.write('new.txt', 'y');
    const nameOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        return (error as Error).name;
      }
      return 'none';
    };
    expect(nameOf(() => resolveCodeCommit(['a.txt'], { cwd: r.dir }))).toBe('DirtyTransformSource');
    expect(nameOf(() => resolveCodeCommit(['new.txt'], { cwd: r.dir, allowDirty: true }))).toBe(
      'NoCodeCommit',
    );
  });
});

describe('lockSubtreeSha256', () => {
  const lock = (packages: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });
  const base = {
    'node_modules/a': { version: '1.0.0', integrity: 'sha512-a', dependencies: { b: '^1.0.0' } },
    'node_modules/b': { version: '1.2.0', integrity: 'sha512-b' },
    'node_modules/c': { version: '9.9.9', integrity: 'sha512-c' },
  };

  it('ignores a package outside the subtree and changes when a transitive dependency changes', () => {
    const one = lockSubtreeSha256(lock(base), ['a']);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    const unrelated = { ...base, 'node_modules/c': { version: '10.0.0', integrity: 'sha512-c2' } };
    expect(lockSubtreeSha256(lock(unrelated), ['a'])).toBe(one);
    const deeper = { ...base, 'node_modules/b': { version: '1.3.0', integrity: 'sha512-b2' } };
    expect(lockSubtreeSha256(lock(deeper), ['a'])).not.toBe(one);
  });

  it('resolves a nested node_modules entry before the hoisted one', () => {
    const nested = {
      ...base,
      'node_modules/a/node_modules/b': { version: '2.0.0', integrity: 'sha512-b3' },
    };
    expect(lockSubtreeSha256(lock(nested), ['a'])).not.toBe(lockSubtreeSha256(lock(base), ['a']));
    const bumpHoisted = {
      ...nested,
      'node_modules/b': { version: '1.9.9', integrity: 'sha512-z' },
    };
    expect(lockSubtreeSha256(lock(bumpHoisted), ['a'])).toBe(
      lockSubtreeSha256(lock(nested), ['a']),
    );
  });

  it('throws when a root or a required dependency is missing, and when roots is empty', () => {
    expect(() => lockSubtreeSha256(lock(base), ['nope'])).toThrow(/not in the lockfile/);
    const missing = { 'node_modules/a': base['node_modules/a'] };
    expect(() => lockSubtreeSha256(lock(missing), ['a'])).toThrow(/needed by a/);
    expect(() => lockSubtreeSha256(lock(base), [])).toThrow(/empty/);
  });

  it('hashes the real package-lock.json for a real root', () => {
    const text = readFileSync(LOCKFILE_URL, 'utf8');
    expect(lockSubtreeSha256(text, ['zod'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

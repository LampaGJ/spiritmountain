import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Helpers shared by #7, #8, #9 and #10 for building replay records. The ReplayRecordSchema itself
 * lives in src/schema/replay.ts (owned by #6) and is not redeclared here.
 */

/** package-lock.json at the repo root, resolved from this module so it works from any cwd. */
export const LOCKFILE_URL = new URL('../../package-lock.json', import.meta.url);

/** sha256 of bytes or a string as 64 lowercase hex characters. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A listed transform source has uncommitted changes. `name` is exactly 'DirtyTransformSource':
 * #9's and #10's name checks and #10's test fakes depend on that string.
 */
export class DirtyTransformSource extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirtyTransformSource';
  }
}

/** No commit touches the listed transform sources (not committed yet). `name` is exactly 'NoCodeCommit'. */
export class NoCodeCommit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoCodeCommit';
  }
}

/**
 * The 40-hex git commit that last touched any of sourcePaths, for the codeCommit field of a replay
 * record (`git log -1 --format=%H -- <sourcePaths>`). It is source-scoped, not HEAD, because HEAD
 * moves when a transform's output is committed, which would break byte-identical replay of the
 * record; this value stays stable until the transform code itself changes.
 * Throws a plain Error if sourcePaths is empty, NoCodeCommit if no commit touches them (sources not
 * committed yet), and DirtyTransformSource if any of them has uncommitted changes (a record naming a
 * commit that lacks the code that ran is a false proof), unless allowDirty is true.
 */
export function resolveCodeCommit(
  sourcePaths: readonly string[],
  { allowDirty = false, cwd }: { allowDirty?: boolean; cwd?: string } = {},
): string {
  if (sourcePaths.length === 0) throw new Error('resolveCodeCommit: sourcePaths is empty');
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
  const commit = git(['log', '-1', '--format=%H', '--', ...sourcePaths]);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new NoCodeCommit(
      `resolveCodeCommit: no commit touches ${sourcePaths.join(', ')}; commit the sources first`,
    );
  }
  if (!allowDirty) {
    const dirty = git(['status', '--porcelain', '--', ...sourcePaths]);
    if (dirty) {
      throw new DirtyTransformSource(
        `resolveCodeCommit: uncommitted changes in source paths:\n${dirty}`,
      );
    }
  }
  return commit;
}

// In-file lockfile parse (not exported, so it is not a registry schema): package-lock.json is a
// foreign file, parsed at the boundary before any entry is read.
const LockEntrySchema = z.looseObject({
  version: z.string().optional(),
  integrity: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});
const LockfileSchema = z.looseObject({ packages: z.record(z.string(), LockEntrySchema) });

/**
 * sha256 over the runtime-dependency subtree of package-lock.json that a transform uses: the sorted,
 * de-duplicated `name@version integrity` lines of the named roots and everything they reach through
 * `dependencies` and `optionalDependencies` (resolved Node-style, nested node_modules first). It
 * changes only when that subtree changes, so an unrelated dependency bump leaves a sidecar valid,
 * which is why the lockfile itself is not in TRANSFORM_SOURCES (R-05). Pass LOCKFILE_URL's text.
 * Documented exception to frameworks-over-custom-code: about 30 lines of domain logic for this one
 * replay rule, and no library hashes a lock subtree.
 */
export function lockSubtreeSha256(lockText: string, roots: readonly string[]): string {
  if (roots.length === 0) throw new Error('lockSubtreeSha256: roots is empty');
  const { packages } = LockfileSchema.parse(JSON.parse(lockText));
  const lookup = (from: string, name: string): string | undefined => {
    let base = from;
    for (;;) {
      const key = `${base === '' ? '' : `${base}/`}node_modules/${name}`;
      if (packages[key] !== undefined) return key;
      if (base === '') return undefined;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut === -1 ? '' : base.slice(0, cut);
    }
  };
  const stack: string[] = [];
  for (const root of roots) {
    const key = lookup('', root);
    if (key === undefined) throw new Error(`lockSubtreeSha256: ${root} is not in the lockfile`);
    stack.push(key);
  }
  const seen = new Set<string>();
  const lines = new Set<string>();
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key];
    if (entry === undefined) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    lines.add(`${name}@${entry.version ?? ''} ${entry.integrity ?? ''}`);
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      const next = lookup(key, dep);
      if (next === undefined)
        throw new Error(`lockSubtreeSha256: ${dep} (needed by ${name}) is not in the lockfile`);
      stack.push(next);
    }
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) {
      const next = lookup(key, dep);
      if (next !== undefined) stack.push(next);
    }
  }
  return sha256Hex(`${[...lines].sort().join('\n')}\n`);
}

import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AnnotationsError, generateAnnotations } from './annotations-core';
import { resolveCodeCommit, sha256Hex } from './replay';

/** The transform's own source files, listed explicitly. codeCommit is the last commit touching any of them. */
export const TRANSFORM_SOURCES = [
  'scripts/ingest/annotations.ts',
  'scripts/ingest/annotations-core.ts',
  'scripts/ingest/replay.ts',
  'src/schema/area.ts',
  'src/schema/annotation.ts',
  'src/schema/organization.ts',
  'src/schema/annotations-file.ts',
  'src/schema/replay.ts',
] as const;

export type MainDeps = {
  /** Returns the codeCommit. Tests inject a fixed value; the real default is resolveCodeCommit over TRANSFORM_SOURCES. */
  resolveCommit?: (allowDirty: boolean) => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

async function readInput(path: string, label: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (cause) {
    throw new AnnotationsError(
      'InputMissing',
      `cannot read ${label} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

/** Writes a temp file in the same directory, then renames it over the target. Replaces whatever is there. */
async function replaceFile(target: string, data: string | Uint8Array): Promise<void> {
  const temp = `${target}.tmp`;
  await writeFile(temp, data);
  await rename(temp, target);
}

/** Writes a temp file, then hard-links it to the target: the link fails with EEXIST if anything is already there, so create-if-absent is one atomic step. */
async function publishNew(
  target: string,
  data: string | Uint8Array,
): Promise<'created' | 'exists'> {
  const temp = `${target}.tmp`;
  await writeFile(temp, data);
  try {
    await link(temp, target);
    return 'created';
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw cause;
  } finally {
    await unlink(temp);
  }
}

/**
 * @displayName Seed annotations entry point
 * @strategicPurpose Produces data/annotations.json and data/annotations.replay.json by a committed, replayable transform, and never overwrites a human-edited annotations file without --force.
 * @tacticalObjective Reads both inputs once, derives codeCommit from the last commit touching the transform sources, runs the pure generator, then writes atomically. Exit 0 ok, 1 named error, 2 refused overwrite.
 */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          force: { type: 'boolean', default: false },
          'allow-dirty': { type: 'boolean', default: false },
          out: { type: 'string', default: 'data' },
          areas: { type: 'string', default: 'data/areas.geojson' },
          seed: { type: 'string', default: 'scripts/ingest/organizations.seed.json' },
        },
        strict: true,
      }));
    } catch (cause) {
      throw new AnnotationsError(
        'BadArguments',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    const allowDirty = values['allow-dirty'];
    const areasBytes = await readInput(values.areas, 'areas file');
    const seedBytes = await readInput(values.seed, 'organizations seed');
    let codeCommit: string;
    try {
      codeCommit = (
        deps.resolveCommit ??
        ((dirtyOk: boolean) => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty: dirtyOk }))
      )(allowDirty);
    } catch (cause) {
      // An unnamed Error is not a named failure of this transform: rethrow it as itself, never relabel it NoCodeCommit.
      if (!(cause instanceof Error) || cause.name === 'Error') throw cause;
      throw new AnnotationsError(cause.name, cause.message);
    }
    if (allowDirty)
      err('WARNING: --allow-dirty was given; this output is not a reproducible record.\n');

    const { fileText, replayText, counts } = generateAnnotations({
      areasBytes,
      seedBytes,
      codeCommit,
    });

    const target = join(values.out, 'annotations.json');
    const sidecar = join(values.out, 'annotations.replay.json');
    await mkdir(values.out, { recursive: true });
    // "exists" means any directory entry at the path: a file (even zero bytes), a directory, or a dangling symlink.
    const existing = await lstatOrNull(target);
    if (existing !== null && !values.force) {
      throw new AnnotationsError(
        'AnnotationsExist',
        `${target} already exists; nothing was written. Re-run with --force to replace it (the old bytes are backed up first).`,
      );
    }
    if (existing !== null) {
      if (!existing.isFile()) {
        throw new AnnotationsError(
          'AnnotationsTargetNotFile',
          `${target} exists but is not a regular file; refusing to back up or replace it`,
        );
      }
      // Read once; hash and back up those same bytes.
      const old = await readFile(target);
      const backup = join(values.out, `annotations.${sha256Hex(old).slice(0, 12)}.bak.json`);
      if (
        (await publishNew(backup, old)) === 'exists' &&
        Buffer.compare(await readFile(backup), old) !== 0
      ) {
        throw new AnnotationsError(
          'BackupConflict',
          `${backup} exists with different bytes; not overwriting it`,
        );
      }
      out(`backed up previous file to ${backup}\n`);
      await replaceFile(target, fileText);
    } else if ((await publishNew(target, fileText)) === 'exists') {
      throw new AnnotationsError(
        'AnnotationsExist',
        `${target} appeared while writing; nothing was replaced`,
      );
    }
    // The replay file is generated, not human-edited, so it is always replaced. It is written second: a crash between the two writes
    // leaves annotations.json with a missing or stale replay file, and --force repairs it.
    await replaceFile(sidecar, replayText);
    out(
      `wrote ${target} (${counts.areas} annotations, ${counts.organizations} organizations) and ${sidecar}\n`,
    );
    return 0;
  } catch (cause) {
    if (cause instanceof AnnotationsError) {
      err(`ERROR ${cause.code}: ${cause.message}\n`);
      return cause.code === 'AnnotationsExist' ? 2 : 1;
    }
    throw cause;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { generatePlaces, PlacesError } from './places-core';
import { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/places.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/local-frame.ts',
  'scripts/ingest/places-core.ts',
  'scripts/ingest/places.ts',
  'scripts/ingest/replay.ts',
  'src/schema/area.ts',
  'src/schema/frame.ts',
  'src/schema/places.ts',
  'src/schema/replay.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay sidecar. */
export const LOCK_ROOTS: readonly string[] = ['proj4', 'zod'];

/**
 * @displayName Places replay schema
 * @strategicPurpose Proves data/places.json replays from the seed, the areas and the frame: the shared replay record plus the package versions and lockfile subtree that did the projection.
 * @tacticalObjective Extends ReplayRecordSchema with toolVersions (proj4 and zod) and lockSubtreeSha256.
 */
export const PlacesReplaySchema = ReplayRecordSchema.extend({
  toolVersions: z.strictObject({ proj4: z.string().min(1), zod: z.string().min(1) }),
  lockSubtreeSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PlacesReplay = z.infer<typeof PlacesReplaySchema>;

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
    throw new PlacesError(
      'InputMissing',
      `cannot read ${label} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

const LockVersionsSchema = z.looseObject({
  packages: z.record(z.string(), z.looseObject({ version: z.string().optional() })),
});

function toolVersions(lockText: string): PlacesReplay['toolVersions'] {
  const parsed = LockVersionsSchema.safeParse(JSON.parse(lockText));
  const version = (name: string): string => {
    const found = parsed.success
      ? parsed.data.packages[`node_modules/${name}`]?.version
      : undefined;
    if (found === undefined)
      throw new PlacesError('BadLockfile', `package-lock.json has no ${name}`);
    return found;
  };
  return { proj4: version('proj4'), zod: version('zod') };
}

/**
 * @displayName Places entry point
 * @strategicPurpose Produces data/places.json and data/places.replay.json by a committed, replayable transform from the primary-source seed, the pinned areas and the frame, and never overwrites without --force.
 * @tacticalObjective Reads the three inputs once, derives codeCommit from the last commit touching the transform sources, runs the pure generator, then writes both files by temp-and-rename. Exit 0 ok, 1 named error, 2 refused overwrite.
 * @manipulation preserves
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
          frame: { type: 'string', default: 'data/frame.json' },
          seed: { type: 'string', default: 'scripts/ingest/places.seed.json' },
        },
        strict: true,
      }));
    } catch (cause) {
      throw new PlacesError('BadArguments', cause instanceof Error ? cause.message : String(cause));
    }
    const allowDirty = values['allow-dirty'];
    const areasBytes = await readInput(values.areas, 'areas file');
    const frameBytes = await readInput(values.frame, 'frame file');
    const seedBytes = await readInput(values.seed, 'places seed');
    let codeCommit: string;
    try {
      codeCommit = (
        deps.resolveCommit ??
        ((dirtyOk: boolean) => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty: dirtyOk }))
      )(allowDirty);
    } catch (cause) {
      // An unnamed Error is not a named failure of this transform: rethrow it as itself, never relabel it.
      if (!(cause instanceof Error) || cause.name === 'Error') throw cause;
      throw new PlacesError(cause.name, cause.message);
    }
    if (allowDirty)
      err('WARNING: --allow-dirty was given; this output is not a reproducible record.\n');

    const { fileText, inputHash, file } = generatePlaces({
      seedBytes,
      areasBytes,
      frameBytes,
      codeCommit,
    });
    const lockText = await readFile(LOCKFILE_URL, 'utf8');
    const replay = PlacesReplaySchema.safeParse({
      inputHash,
      codeCommit,
      outputHash: sha256Hex(fileText),
      effect: 'preserves',
      toolVersions: toolVersions(lockText),
      lockSubtreeSha256: lockSubtreeSha256(lockText, LOCK_ROOTS),
    });
    if (!replay.success) throw new PlacesError('ReplayInvalid', replay.error.message);

    const target = join(values.out, 'places.json');
    const sidecar = join(values.out, 'places.replay.json');
    await mkdir(values.out, { recursive: true });
    if (!values.force && ((await exists(target)) || (await exists(sidecar)))) {
      throw new PlacesError(
        'PlacesExist',
        `${target} or ${sidecar} already exists; nothing was written. Re-run with --force to replace them.`,
      );
    }
    await writeAtomic(target, fileText);
    // The sidecar is written second: a crash between the two leaves a stale sidecar, and --force repairs it.
    await writeAtomic(sidecar, `${JSON.stringify(replay.data, null, 2)}\n`);
    const verified = file.places.filter((p) => p.verified).length;
    out(`wrote ${target} (${file.places.length} places, ${verified} verified) and ${sidecar}\n`);
    return 0;
  } catch (cause) {
    if (cause instanceof PlacesError) {
      err(`ERROR ${cause.code}: ${cause.message}\n`);
      return cause.code === 'PlacesExist' ? 2 : 1;
    }
    throw cause;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

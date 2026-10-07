import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import { ContextManifestSchema } from './context-manifest-schema';
import { CONTEXT_TILES, tileKey } from './context-tiles';
import {
  LOCKFILE_URL,
  lockSubtreeSha256,
  readFrame,
  resolveCodeCommit,
  sha256Hex,
  type Frame,
} from './terrain-deps';
import { TerrainError, buildTerrain, renderHeaderJson } from './terrain';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/context-terrain.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/context-manifest-schema.ts',
  'scripts/ingest/context-terrain.ts',
  'scripts/ingest/context-tiles.ts',
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/replay.ts',
  'scripts/ingest/terrain-deps.ts',
  'scripts/ingest/terrain.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
  'src/schema/terrain.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['geotiff', 'zod'];

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Context terrain replay record
 * @strategicPurpose Proves the 12 context heightfields (24 files) are reproducible from the pinned context TIFFs and the committed transform code, in one record rather than twelve.
 * @tacticalObjective Validates the base replay record plus per-file output hashes, the geotiff version and the lockfile subtree hash before data/context/context.replay.json is written.
 */
export const ContextReplaySchema = ReplayRecordSchema.extend({
  outputs: z.record(z.string(), Sha256Schema),
  toolVersions: z.strictObject({ geotiff: z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
});
export type ContextReplay = z.infer<typeof ContextReplaySchema>;

/** The server snaps the box to square pixels (it measured 0.15 m off on 232 x 225 px), so the decoded bbox may differ from the request by under half a pixel. The decoded box is the one the header records. */
const BBOX_TOLERANCE_CELLS = 0.5;

const PackageSchema = z.looseObject({ dependencies: z.record(z.string(), z.string()) });

function geotiffVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const version = PackageSchema.parse(JSON.parse(text)).dependencies['geotiff'];
  if (version === undefined)
    throw new TerrainError('BadRaster', 'package.json has no geotiff dependency');
  return version;
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

export interface ContextRunOptions {
  dataDir: string;
  frame: Frame;
  frameSha256: string;
  lockSubtree: string;
  resolveCommit: () => string;
}

/**
 * @displayName Build context heightfields
 * @strategicPurpose Converts the 12 pinned context TIFFs once into typed-array heightfields in the shared local frame, with the same decode, nodata and header rules as the centre terrain; pure so a rerun is byte-identical.
 * @tacticalObjective Verifies each TIFF against the context manifest sha256, size and bbox, decodes it with buildTerrain, writes data/context/<i>_<j>.f32 and .json, then context.replay.json last.
 */
export async function runContextTerrain(
  options: ContextRunOptions,
): Promise<{ headers: TerrainHeader[]; replay: ContextReplay }> {
  const manifest = ContextManifestSchema.parse(
    JSON.parse(readFileSync(join(options.dataDir, 'raw', 'context', 'manifest.json'), 'utf8')),
  );
  const outDir = join(options.dataDir, 'context');
  const staged: { name: string; bytes: Uint8Array }[] = [];
  const headers: TerrainHeader[] = [];
  const inputLines: string[] = [];
  const outputs: Record<string, string> = {};
  const hashed: Uint8Array[] = [];

  for (const [i, j] of CONTEXT_TILES) {
    const key = tileKey(i, j);
    const entry = manifest.tiles.find((t) => t.i === i && t.j === j);
    if (entry === undefined) {
      throw new TerrainError('PinnedInputHashMismatch', `manifest has no tile ${key}`);
    }
    const tiff = readFileSync(join(options.dataDir, 'raw', 'context', `${key}.tif`));
    const inputSha256 = sha256Hex(tiff);
    if (inputSha256 !== entry.terrain.sha256) {
      throw new TerrainError(
        'PinnedInputHashMismatch',
        `${key}.tif sha256 ${inputSha256} differs from the manifest pin ${entry.terrain.sha256}`,
      );
    }
    const built = await buildTerrain(tiff, {
      frame: options.frame,
      frameSha256: options.frameSha256,
      inputSha256,
    });
    if (
      built.header.width !== entry.terrain.width ||
      built.header.height !== entry.terrain.height
    ) {
      throw new TerrainError(
        'ManifestDimensionMismatch',
        `${key}: TIFF is ${built.header.width}x${built.header.height}, manifest says ${entry.terrain.width}x${entry.terrain.height}`,
      );
    }
    for (const side of ['xmin', 'ymin', 'xmax', 'ymax'] as const) {
      if (
        Math.abs(built.bbox[side] - entry.bbox[side]) >
        BBOX_TOLERANCE_CELLS * entry.terrain.metresPerPixel
      ) {
        throw new TerrainError(
          'ManifestDimensionMismatch',
          `${key}: decoded bbox ${side} ${built.bbox[side]} differs from manifest ${entry.bbox[side]}`,
        );
      }
    }
    const checked = TerrainHeaderSchema.safeParse({
      ...built.header,
      source: { path: entry.terrain.path, sha256: inputSha256 },
    });
    if (!checked.success) throw new TerrainError('HeaderInvalid', checked.error.message);
    const header = checked.data;
    const jsonBytes = Buffer.from(renderHeaderJson(header), 'utf8');
    staged.push({ name: `${key}.f32`, bytes: built.f32 });
    staged.push({ name: `${key}.json`, bytes: jsonBytes });
    outputs[`${key}.f32`] = sha256Hex(built.f32);
    outputs[`${key}.json`] = sha256Hex(jsonBytes);
    hashed.push(built.f32, jsonBytes);
    inputLines.push(`${key} ${inputSha256}`);
    headers.push(header);
  }

  const replayCandidate = {
    inputHash: sha256Hex(`${inputLines.join('\n')}\n`),
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(Buffer.concat(hashed)),
    effect: 'preserves',
    outputs,
    toolVersions: { geotiff: geotiffVersion() },
    lockSubtreeSha256: options.lockSubtree,
  };
  const replay = ContextReplaySchema.parse(replayCandidate);
  mkdirSync(outDir, { recursive: true });
  for (const { name, bytes } of staged) writeAtomic(join(outDir, name), bytes);
  writeAtomic(
    join(outDir, 'context.replay.json'),
    Buffer.from(`${JSON.stringify(replayCandidate, null, 2)}\n`, 'utf8'),
  );
  return { headers, replay };
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'allow-dirty': { type: 'boolean', default: false },
    },
  });
  const dataDir = values['data-dir'] ?? 'data';
  const allowDirty = values['allow-dirty'] === true;
  const frameBytes = readFileSync(join(dataDir, 'frame.json'));
  const result = await runContextTerrain({
    dataDir,
    frame: readFrame(frameBytes),
    frameSha256: sha256Hex(frameBytes),
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty }),
  });
  for (const [index, header] of result.headers.entries()) {
    const tile = CONTEXT_TILES[index] as readonly [number, number];
    process.stdout.write(
      `ingest:context-terrain ${tileKey(tile[0], tile[1])} ${header.width}x${header.height} elev ${header.minElev}..${header.maxElev} nodataFilled=${header.nodataFilled}\n`,
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

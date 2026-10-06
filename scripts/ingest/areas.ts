import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import osmtogeojson from 'osmtogeojson';
import { z } from 'zod';
import {
  AreaFeatureCollectionSchema,
  AreaIdSchema,
  AreaKindSchema,
  type AreaFeature,
  type AreaFeatureCollection,
} from '../../src/schema/area';
import { AreasReplaySchema, type AreasReplay, type DroppedEntry } from './areas-replay-schema';
import { serializeAreas, serializeReplay } from './areas-serialize';
import { mapKind } from './kind-mapping';
import { BBOX, FRAME, toLocal } from './local-frame';
import { ManifestSchema } from './manifest-schema';
import { OverpassEnvelopeSchema, type OverpassEnvelope } from './overpass-schema';
import { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';

type Element = OverpassEnvelope['elements'][number];
type Position = [number, number, number];

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/areas.test.ts). */
export const TRANSFORM_SOURCES: readonly string[] = [
  'scripts/ingest/areas.ts',
  'scripts/ingest/areas-replay-schema.ts',
  'scripts/ingest/areas-serialize.ts',
  'scripts/ingest/kind-mapping.ts',
  'scripts/ingest/local-frame.ts',
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/overpass-schema.ts',
  'scripts/ingest/replay.ts',
  'src/schema/area.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay sidecar (lockSubtreeSha256). */
export const LOCK_ROOTS: readonly string[] = ['osmtogeojson', 'proj4', 'zod'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(name: string, message: string): never {
  const error = new Error(message);
  error.name = name;
  throw error;
}

const inBbox = (lon: number, lat: number): boolean =>
  lat >= BBOX.south && lat <= BBOX.north && lon >= BBOX.west && lon <= BBOX.east;

const project = ([lon, lat]: readonly [number, number]): Position => {
  const [x, y] = toLocal(lon, lat);
  return [x, y, 0];
};

const LonLat = z.tuple([z.number(), z.number()]);
const Line = z.array(LonLat);
const Rings = z.array(Line);
const ConversionSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.looseObject({
      id: AreaIdSchema,
      geometry: z.looseObject({ type: z.string(), coordinates: z.unknown() }),
    }),
  ),
});

type LonLatGeometry =
  | { type: 'LineString'; coordinates: Array<[number, number]> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }
  | { type: 'other' };

/**
 * @displayName osmtogeojson result gate
 * @strategicPurpose Guards the boundary into the osmtogeojson beta so a changed output shape fails by name instead of yielding empty areas.
 * @tacticalObjective Parses the library result as a FeatureCollection whose features all carry a node/way/relation id and a geometry, and returns the way geometries keyed by feature id; throws OsmtogeojsonContract otherwise.
 */
export function parseConversion(converted: unknown): Record<string, LonLatGeometry> {
  const parsed = ConversionSchema.safeParse(converted);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(
      'OsmtogeojsonContract',
      `osmtogeojson output violates the contract at ${issue?.path.join('.') ?? '?'}`,
    );
  }
  const ways: Record<string, LonLatGeometry> = {};
  for (const { id, geometry } of parsed.data.features) {
    if (!id.startsWith('way/')) continue;
    const line = geometry.type === 'LineString' ? Line.safeParse(geometry.coordinates) : undefined;
    const rings = geometry.type === 'Polygon' ? Rings.safeParse(geometry.coordinates) : undefined;
    if (line?.success === false || rings?.success === false)
      fail('OsmtogeojsonContract', `${id} has malformed coordinates`);
    ways[id] = line?.success
      ? { type: 'LineString', coordinates: line.data }
      : rings?.success
        ? { type: 'Polygon', coordinates: rings.data }
        : { type: 'other' };
  }
  return ways;
}

const FAMILIES = ['piste:type', 'aerialway', 'mtb:scale'] as const;

function checkFamilies(elements: readonly Element[]): void {
  if (elements.length === 0) fail('OverpassEmpty', 'the pinned Overpass file has zero elements');
  for (const family of FAMILIES) {
    if (!elements.some((element) => element.tags?.[family] !== undefined)) {
      fail(
        'OverpassMissingFamily',
        `no element carries the ${family} tag; an upstream rename would look like an empty result`,
      );
    }
  }
}

/** Inputs the pure core needs that come from outside it (git, process). */
export interface BuildContext {
  codeCommit: string;
  toolVersions: AreasReplay['toolVersions'];
  lockSubtreeSha256: string;
}

/** Everything the core produces; the shell only writes it. */
export interface BuildResult {
  collection: AreaFeatureCollection;
  replay: AreasReplay;
  geojsonText: string;
  replayText: string;
}

/**
 * @displayName OSM to areas transform
 * @strategicPurpose The manipulation node that turns the pinned Overpass JSON into the canonical local-metre areas the scene draws, with every dropped element accounted for.
 * @tacticalObjective Parses the pinned bytes, maps kinds, explodes relation members that are not way elements (relation name in osmTags under route:name), projects to the local frame, records every drop, asserts the partition identity, validates with AreaFeatureCollectionSchema, and returns the stable bytes plus the replay record. No filesystem, network, clock or git access.
 */
export function buildAreas(rawBytes: Uint8Array, ctx: BuildContext): BuildResult {
  const envelope = OverpassEnvelopeSchema.parse(JSON.parse(Buffer.from(rawBytes).toString('utf8')));
  const elements = envelope.elements;
  checkFamilies(elements);

  // osmtogeojson MUTATES its input (it appends pseudo-ways named _fullGeom<id> for relation members), so it gets a clone.
  const wayGeometry = parseConversion(
    osmtogeojson(structuredClone(envelope), { flatProperties: false }),
  );
  const features: AreaFeature[] = [];
  const dropped: DroppedEntry[] = [];
  const drop = (id: string, reason: DroppedEntry['reason'], detail?: string): void => {
    dropped.push(detail === undefined ? { id, reason } : { id, reason, detail });
  };
  const produced: string[] = [];
  const wayElementKeys = elements.filter((e) => e.type === 'way').map((e) => `way/${e.id}`);
  const seenFeatureIds: string[] = [];

  const sorted = [...elements].sort((a, b) => byCodeUnit(`${a.type}/${a.id}`, `${b.type}/${b.id}`));

  for (const element of sorted) {
    const key = `${element.type}/${element.id}`;
    const tags = element.tags ?? {};
    if (element.type === 'node') {
      const lift = tags['aerialway'];
      if (lift === 'pylon') drop(key, 'node-pylon');
      else if (lift === 'station') drop(key, 'node-station');
      else drop(key, 'node-other', 'no-lift-tag');
    } else if (element.type === 'way') {
      const mapped = mapKind(tags);
      if (!mapped.ok) {
        drop(key, mapped.reason, mapped.detail);
        continue;
      }
      const geometry = wayGeometry[key];
      if (geometry === undefined || geometry.type === 'other') {
        drop(
          key,
          'unsupported-geometry',
          geometry === undefined ? 'missing' : 'not-line-or-polygon',
        );
        continue;
      }
      const vertices =
        geometry.type === 'LineString' ? geometry.coordinates : geometry.coordinates.flat();
      if (!vertices.some(([lon, lat]) => inBbox(lon, lat))) {
        drop(key, 'outside-bbox');
        continue;
      }
      features.push({
        type: 'Feature',
        properties: {
          id: key,
          kind: mapped.kind,
          name: tags['name'] === undefined || tags['name'] === '' ? null : tags['name'],
          difficulty: mapped.difficulty,
          osmTags: { ...tags },
        },
        geometry:
          geometry.type === 'LineString'
            ? { type: 'LineString', coordinates: geometry.coordinates.map(project) }
            : {
                type: 'Polygon',
                coordinates: geometry.coordinates.map((ring) => ring.map(project)),
              },
      });
      seenFeatureIds.push(key);
      produced.push(key);
    }
  }

  const relations = elements.filter((e) => e.type === 'relation').sort((a, b) => a.id - b.id);
  for (const relation of relations) {
    const key = `relation/${relation.id}`;
    const tags = relation.tags ?? {};
    const mapped = mapKind(tags);
    if (!mapped.ok) {
      drop(key, 'relation-unmapped', mapped.detail);
      continue;
    }
    let created = 0;
    for (const member of relation.members) {
      const memberKey = `${member.type}/${member.ref}`;
      const droppedId = `${key}#${memberKey}`;
      if (member.type !== 'way') {
        drop(droppedId, 'unsupported-member', `member type ${member.type}`);
        continue;
      }
      if (wayElementKeys.includes(memberKey)) continue; // the way element itself carries this area
      if (seenFeatureIds.includes(memberKey)) {
        drop(droppedId, 'duplicate-member', 'already exploded from an earlier relation');
        continue;
      }
      const line = member.geometry ?? [];
      if (line.length < 2) {
        drop(droppedId, 'unsupported-geometry', 'member geometry has fewer than 2 points');
        continue;
      }
      if (!line.some((p) => inBbox(p.lon, p.lat))) {
        drop(droppedId, 'outside-bbox');
        continue;
      }
      const name = tags['name'];
      features.push({
        type: 'Feature',
        properties: {
          id: memberKey,
          kind: mapped.kind,
          name: null,
          difficulty: mapped.difficulty,
          osmTags: name === undefined || name === '' ? {} : { 'route:name': name },
        },
        geometry: { type: 'LineString', coordinates: line.map((p) => project([p.lon, p.lat])) },
      });
      seenFeatureIds.push(memberKey);
      created += 1;
    }
    if (created > 0) produced.push(key);
    else drop(key, 'relation-no-new-members', 'every member is a way element or was dropped');
  }

  // Effect proof (declared effect: reduces): every input element is a feature producer or dropped, never both, never neither.
  const elementDrops = dropped.filter((d) => !d.id.includes('#')).map((d) => d.id);
  const accounted = [...produced, ...elementDrops].sort(byCodeUnit);
  const inputKeys = elements.map((e) => `${e.type}/${e.id}`).sort(byCodeUnit);
  if (accounted.length !== inputKeys.length || accounted.some((id, i) => id !== inputKeys[i])) {
    fail(
      'EffectViolated',
      `partition identity broken: ${inputKeys.length} input elements, ${accounted.length} accounted for`,
    );
  }

  features.sort((a, b) => byCodeUnit(a.properties.id, b.properties.id));
  dropped.sort(
    (a, b) =>
      byCodeUnit(a.id, b.id) ||
      byCodeUnit(a.reason, b.reason) ||
      byCodeUnit(a.detail ?? '', b.detail ?? ''),
  );

  const gate = AreaFeatureCollectionSchema.safeParse({ type: 'FeatureCollection', features });
  if (!gate.success) {
    const issue = gate.error.issues[0];
    return fail(
      'AreaSchemaViolation',
      `emitter gate: ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? ''}`,
    );
  }
  const collection = gate.data;

  const geojsonText = serializeAreas(collection);
  const tally = (names: readonly string[]): Record<string, number> =>
    Object.fromEntries([...names].sort(byCodeUnit).map((name) => [name, 0])) as Record<
      string,
      number
    >;
  const counts = tally(AreaKindSchema.options);
  for (const f of collection.features)
    counts[f.properties.kind] = (counts[f.properties.kind] ?? 0) + 1;
  const droppedCounts = tally([...new Set(dropped.map((d) => d.reason))]);
  for (const d of dropped) droppedCounts[d.reason] = (droppedCounts[d.reason] ?? 0) + 1;

  const replay = AreasReplaySchema.parse({
    inputHash: sha256Hex(rawBytes),
    codeCommit: ctx.codeCommit,
    outputHash: sha256Hex(Buffer.from(geojsonText, 'utf8')),
    effect: 'reduces',
    toolVersions: ctx.toolVersions,
    lockSubtreeSha256: ctx.lockSubtreeSha256,
    counts,
    droppedCounts,
    dropped,
  });
  return { collection, replay, geojsonText, replayText: serializeReplay(replay) };
}

/** Options for one shell run; root holds data/, the repo root holds the transform sources. */
export interface RunOptions {
  root: string;
  force: boolean;
  allowDirty: boolean;
  resolveCommit?: (sources: readonly string[], opts: { allowDirty: boolean }) => string;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

function readToolVersions(): AreasReplay['toolVersions'] {
  const require = createRequire(import.meta.url);
  const version = (name: string): string =>
    z.looseObject({ version: z.string() }).parse(require(`${name}/package.json`)).version;
  return {
    osmtogeojson: version('osmtogeojson'),
    proj4: version('proj4'),
  };
}

/**
 * @displayName Areas shell
 * @strategicPurpose The only part that touches files and git: parses every input at the boundary, then writes both outputs atomically.
 * @tacticalObjective Reads manifest.json, overpass.json and frame.json from root/data, verifies manifest.overpass.sha256 and that frame.json equals FRAME, resolves codeCommit, runs buildAreas, refuses to overwrite without force, writes temp files then renames. Returns exit code 0 ok, 1 named error, 2 refused overwrite.
 */
export async function runAreas(options: RunOptions): Promise<{ code: 0 | 1 | 2; message: string }> {
  const rawPath = join(options.root, 'data/raw/overpass.json');
  const outPath = join(options.root, 'data/areas.geojson');
  const replayPath = join(options.root, 'data/areas.replay.json');
  const temps: string[] = [];
  try {
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(join(options.root, 'data/raw/manifest.json'), 'utf8')),
    );
    const rawBytes = new Uint8Array(await readFile(rawPath));
    const actual = sha256Hex(rawBytes);
    if (actual !== manifest.overpass.sha256)
      fail(
        'PinnedInputHashMismatch',
        `overpass.json sha256 ${actual} differs from manifest ${manifest.overpass.sha256}`,
      );

    const frame: unknown = JSON.parse(
      await readFile(join(options.root, 'data/frame.json'), 'utf8'),
    );
    if (!isDeepStrictEqual(frame, FRAME))
      fail('FrameMismatch', 'data/frame.json differs from the frame in local-frame.ts');

    const resolve =
      options.resolveCommit ?? ((sources, opts) => resolveCodeCommit([...sources], opts));
    const codeCommit = resolve(TRANSFORM_SOURCES, { allowDirty: options.allowDirty });
    const built = buildAreas(rawBytes, {
      codeCommit,
      toolVersions: readToolVersions(),
      lockSubtreeSha256: lockSubtreeSha256(await readFile(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    });

    if (!options.force && ((await exists(outPath)) || (await exists(replayPath)))) {
      return {
        code: 2,
        message:
          'OutputExists: data/areas.geojson or data/areas.replay.json already exists; pass --force to overwrite',
      };
    }
    const tempOut = `${outPath}.tmp-${process.pid}`;
    const tempReplay = `${replayPath}.tmp-${process.pid}`;
    temps.push(tempOut, tempReplay);
    await writeFile(tempOut, Buffer.from(built.geojsonText, 'utf8'));
    await writeFile(tempReplay, Buffer.from(built.replayText, 'utf8'));
    await rename(tempOut, outPath);
    await rename(tempReplay, replayPath);
    return {
      code: 0,
      message: `wrote ${built.collection.features.length} features, ${built.replay.dropped.length} dropped`,
    };
  } catch (error) {
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { code: 1, message: named };
  } finally {
    await Promise.all(temps.map((temp) => rm(temp, { force: true })));
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: '.' },
      force: { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
    },
  });
  const result = await runAreas({
    root: values.root ?? '.',
    force: values.force === true,
    allowDirty: values['allow-dirty'] === true,
  });
  (result.code === 0 ? console.log : console.error)(result.message);
  process.exit(result.code);
}

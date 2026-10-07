import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import osmtogeojson from 'osmtogeojson';
import { z } from 'zod';
import {
  BuildingFeatureCollectionSchema,
  type BuildingFeature,
  type BuildingFeatureCollection,
} from '../../src/schema/building';
import { heightOf, kindOf } from './building-heights';
import { BuildingsManifestSchema } from './buildings-manifest-schema';
import {
  BuildingsReplaySchema,
  type BuildingDroppedEntry,
  type BuildingsReplay,
} from './buildings-replay-schema';
import { serializeBuildings, serializeBuildingsReplay } from './buildings-serialize';
import { BBOX, FRAME, gridEnvelope, ORIGIN, toLocal } from './local-frame';
import { OverpassEnvelopeSchema } from './overpass-schema';
import { LOCKFILE_URL, lockSubtreeSha256, resolveCodeCommit, sha256Hex } from './replay';

type Position = [number, number, number];

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/buildings.test.ts). */
export const TRANSFORM_SOURCES: readonly string[] = [
  'scripts/ingest/building-heights.ts',
  'scripts/ingest/buildings-manifest-schema.ts',
  'scripts/ingest/buildings-replay-schema.ts',
  'scripts/ingest/buildings-serialize.ts',
  'scripts/ingest/buildings.ts',
  'scripts/ingest/areas-replay-schema.ts',
  'scripts/ingest/areas-serialize.ts',
  'scripts/ingest/local-frame.ts',
  'scripts/ingest/overpass-schema.ts',
  'scripts/ingest/replay.ts',
  'src/schema/area.ts',
  'src/schema/building.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay sidecar (lockSubtreeSha256). */
export const LOCK_ROOTS: readonly string[] = ['osmtogeojson', 'proj4', 'zod'];

/** Metres per pixel of the terrain grid (data/terrain.json cellSizeX); the terrain box is its envelope. */
const TERRAIN_METRES_PER_PIXEL = 5;

/** The terrain extent in local metres: the EPSG:26915 grid envelope of BBOX minus ORIGIN. */
export function terrainBox(): { xmin: number; ymin: number; xmax: number; ymax: number } {
  const g = gridEnvelope(BBOX, TERRAIN_METRES_PER_PIXEL);
  return {
    xmin: g.xmin - ORIGIN.easting,
    ymin: g.ymin - ORIGIN.northing,
    xmax: g.xmax - ORIGIN.easting,
    ymax: g.ymax - ORIGIN.northing,
  };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(name: string, message: string): never {
  const error = new Error(message);
  error.name = name;
  throw error;
}

const project = ([lon, lat]: readonly [number, number]): Position => {
  const [x, y] = toLocal(lon, lat);
  return [x, y, 0];
};

const LonLat = z.tuple([z.number(), z.number()]);
const Ring = z.array(LonLat);
const PolygonCoords = z.array(Ring);
const MultiPolygonCoords = z.array(PolygonCoords);
const ConversionSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.looseObject({
      id: z.string(),
      geometry: z.looseObject({ type: z.string(), coordinates: z.unknown() }),
    }),
  ),
});

type LonLatPolygon = Array<Array<[number, number]>>;
type LonLatGeometry =
  | { type: 'polygons'; geometryType: 'Polygon' | 'MultiPolygon'; polygons: LonLatPolygon[] }
  | { type: 'other'; geometryType: string };

/**
 * @displayName osmtogeojson buildings result gate
 * @strategicPurpose Guards the boundary into the osmtogeojson beta so a changed output shape fails by name instead of yielding zero buildings.
 * @tacticalObjective Parses the library result as a FeatureCollection whose features all carry a string id and a geometry, and returns the polygon geometries keyed by feature id (Polygon becomes one polygon, MultiPolygon keeps its outer-ring order); throws OsmtogeojsonContract otherwise.
 */
export function parseBuildingConversion(converted: unknown): Record<string, LonLatGeometry> {
  const parsed = ConversionSchema.safeParse(converted);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(
      'OsmtogeojsonContract',
      `osmtogeojson output violates the contract at ${issue?.path.join('.') ?? '?'}`,
    );
  }
  const byId: Record<string, LonLatGeometry> = {};
  for (const { id, geometry } of parsed.data.features) {
    if (geometry.type === 'Polygon') {
      const coords = PolygonCoords.safeParse(geometry.coordinates);
      if (!coords.success) return fail('OsmtogeojsonContract', `${id} has malformed coordinates`);
      byId[id] = { type: 'polygons', geometryType: 'Polygon', polygons: [coords.data] };
    } else if (geometry.type === 'MultiPolygon') {
      const coords = MultiPolygonCoords.safeParse(geometry.coordinates);
      if (!coords.success) return fail('OsmtogeojsonContract', `${id} has malformed coordinates`);
      byId[id] = { type: 'polygons', geometryType: 'MultiPolygon', polygons: coords.data };
    } else {
      byId[id] = { type: 'other', geometryType: geometry.type };
    }
  }
  return byId;
}

/** Area-weighted centroid of a closed ring; the vertex mean when the ring has zero area. */
export function ringCentroid(ring: readonly Position[]): [number, number] {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [x0, y0] = ring[i] as Position;
    const [x1, y1] = ring[i + 1] as Position;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (twiceArea !== 0) return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
  const open = ring.slice(0, -1);
  const n = Math.max(open.length, 1);
  return [open.reduce((s, p) => s + p[0], 0) / n, open.reduce((s, p) => s + p[1], 0) / n];
}

/** Inputs the pure core needs that come from outside it (git, process, command line). */
export interface BuildContext {
  codeCommit: string;
  toolVersions: BuildingsReplay['toolVersions'];
  lockSubtreeSha256: string;
  /** Keep only buildings whose centroid lies within this many metres of the frame centre; null keeps the whole terrain box. */
  radiusM: number | null;
}

/** Everything the core produces; the shell only writes it. */
export interface BuildResult {
  collection: BuildingFeatureCollection;
  replay: BuildingsReplay;
  geojsonText: string;
  replayText: string;
}

/**
 * @displayName OSM to buildings transform
 * @strategicPurpose The manipulation node that turns the pinned Overpass buildings JSON into the canonical local-metre footprints the scene extrudes, with every dropped element or ring accounted for.
 * @tacticalObjective Parses the pinned bytes, converts with osmtogeojson on a clone, keeps Polygon and MultiPolygon (one feature per outer ring, id suffix #n, holes kept), assigns heightM from building-heights, projects to the local frame, drops centroids outside the terrain box or radius, records every drop, asserts the partition identity (declared effect: reduces), validates with BuildingFeatureCollectionSchema, and returns the stable bytes plus the replay record. No filesystem, network, clock or git access.
 */
export function buildBuildings(rawBytes: Uint8Array, ctx: BuildContext): BuildResult {
  if (ctx.radiusM !== null && !(Number.isFinite(ctx.radiusM) && ctx.radiusM > 0))
    fail('BadArgument', `radiusM must be a positive finite number, got ${String(ctx.radiusM)}`);
  const envelope = OverpassEnvelopeSchema.parse(JSON.parse(Buffer.from(rawBytes).toString('utf8')));
  const elements = envelope.elements.filter((e) => e.type === 'way' || e.type === 'relation');
  if (elements.length === 0)
    fail('OverpassEmpty', 'the pinned buildings file has zero ways or relations');
  if (!elements.some((e) => e.tags?.['building'] !== undefined))
    fail(
      'OverpassMissingFamily',
      'no element carries the building tag; an upstream rename would look like an empty result',
    );

  // osmtogeojson MUTATES its input (it appends pseudo-ways for relation members), so it gets a clone.
  const converted = parseBuildingConversion(
    osmtogeojson(structuredClone(envelope), { flatProperties: false }),
  );
  const box = terrainBox();
  const features: BuildingFeature[] = [];
  const dropped: BuildingDroppedEntry[] = [];
  const drop = (id: string, reason: BuildingDroppedEntry['reason'], detail?: string): void => {
    dropped.push(detail === undefined ? { id, reason } : { id, reason, detail });
  };
  const sourceCounts = { height: 0, levels: 0, 'type-table': 0 };

  const sorted = [...elements].sort((a, b) => byCodeUnit(`${a.type}/${a.id}`, `${b.type}/${b.id}`));
  for (const element of sorted) {
    const key = `${element.type}/${element.id}`;
    const tags = element.tags ?? {};
    if (tags['building'] === 'no') {
      drop(key, 'building-no');
      continue;
    }
    const kind = kindOf(tags);
    if (kind === null) {
      drop(key, 'no-kind', 'neither a building nor a man_made value');
      continue;
    }
    const geometry = converted[key];
    if (geometry === undefined || geometry.type === 'other') {
      drop(
        key,
        'no-polygon',
        geometry === undefined ? 'osmtogeojson emitted no feature' : geometry.geometryType,
      );
      continue;
    }
    const height = heightOf(tags);
    const name = tags['name'] === undefined || tags['name'] === '' ? null : tags['name'];
    geometry.polygons.forEach((polygon, index) => {
      const id = geometry.geometryType === 'MultiPolygon' ? `${key}#${index}` : key;
      if (polygon.length === 0 || polygon.some((ring) => ring.length < 4)) {
        drop(id, 'degenerate-ring', `${polygon.map((r) => r.length).join(',')} positions per ring`);
        return;
      }
      const rings = polygon.map((ring) => ring.map(project));
      const [cx, cy] = ringCentroid(rings[0] as Position[]);
      if (cx < box.xmin || cx > box.xmax || cy < box.ymin || cy > box.ymax) {
        drop(id, 'outside-terrain-box');
        return;
      }
      if (ctx.radiusM !== null && Math.hypot(cx, cy) > ctx.radiusM) {
        drop(id, 'outside-radius', `${Math.round(Math.hypot(cx, cy))} m from the frame centre`);
        return;
      }
      sourceCounts[height.source] += 1;
      features.push({
        type: 'Feature',
        properties: {
          id,
          kind,
          name,
          heightM: height.heightM,
          levels: height.levels,
          source: height.source,
          osmTags: { ...tags },
        },
        geometry: { type: 'Polygon', coordinates: rings },
      });
    });
  }

  // Effect proof (declared effect: reduces): every input element produced a feature, or was dropped (whole, or ring by ring), never neither.
  const baseOf = (id: string): string => id.split('#')[0] as string;
  const producedElements = new Set(features.map((f) => baseOf(f.properties.id)));
  const droppedOnly = new Set(
    dropped.map((d) => baseOf(d.id)).filter((id) => !producedElements.has(id)),
  );
  const inputKeys = elements.map((e) => `${e.type}/${e.id}`).sort(byCodeUnit);
  const accounted = [...producedElements, ...droppedOnly].sort(byCodeUnit);
  if (accounted.length !== inputKeys.length || accounted.some((id, i) => id !== inputKeys[i])) {
    fail(
      'EffectViolated',
      `partition identity broken: ${inputKeys.length} input elements, ${accounted.length} accounted for`,
    );
  }
  if (producedElements.size > inputKeys.length)
    fail(
      'EffectViolated',
      `declared reduces but ${producedElements.size} elements produced from ${inputKeys.length}`,
    );

  features.sort((a, b) => byCodeUnit(a.properties.id, b.properties.id));
  dropped.sort(
    (a, b) =>
      byCodeUnit(a.id, b.id) ||
      byCodeUnit(a.reason, b.reason) ||
      byCodeUnit(a.detail ?? '', b.detail ?? ''),
  );

  const gate = BuildingFeatureCollectionSchema.safeParse({ type: 'FeatureCollection', features });
  if (!gate.success) {
    const issue = gate.error.issues[0];
    return fail(
      'BuildingSchemaViolation',
      `emitter gate: ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? ''}`,
    );
  }
  const collection = gate.data;

  const geojsonText = serializeBuildings(collection);
  const droppedCounts: Record<string, number> = {};
  for (const d of dropped) droppedCounts[d.reason] = (droppedCounts[d.reason] ?? 0) + 1;
  const replay = BuildingsReplaySchema.parse({
    inputHash: sha256Hex(rawBytes),
    codeCommit: ctx.codeCommit,
    outputHash: sha256Hex(Buffer.from(geojsonText, 'utf8')),
    effect: 'reduces',
    toolVersions: ctx.toolVersions,
    lockSubtreeSha256: ctx.lockSubtreeSha256,
    terrainBox: box,
    radiusM: ctx.radiusM,
    counts: {
      droppedElements: droppedOnly.size,
      features: collection.features.length,
      inputElements: inputKeys.length,
      producedElements: producedElements.size,
      sourceHeight: sourceCounts.height,
      sourceLevels: sourceCounts.levels,
      sourceTypeTable: sourceCounts['type-table'],
    },
    droppedCounts: Object.fromEntries(
      Object.entries(droppedCounts).sort(([a], [b]) => byCodeUnit(a, b)),
    ),
    dropped,
  });
  return { collection, replay, geojsonText, replayText: serializeBuildingsReplay(replay) };
}

/** Options for one shell run; root holds data/, the repo root holds the transform sources. */
export interface RunOptions {
  root: string;
  force: boolean;
  allowDirty: boolean;
  radiusM?: number | null;
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

function readToolVersions(): BuildingsReplay['toolVersions'] {
  const require = createRequire(import.meta.url);
  const version = (name: string): string =>
    z.looseObject({ version: z.string() }).parse(require(`${name}/package.json`)).version;
  return { osmtogeojson: version('osmtogeojson'), proj4: version('proj4') };
}

/**
 * @displayName Buildings shell
 * @strategicPurpose The only part that touches files and git: parses every input at the boundary, then writes both outputs atomically.
 * @tacticalObjective Reads buildings-manifest.json, overpass-buildings.json and frame.json from root/data, verifies the manifest sha256 and that frame.json equals FRAME, resolves codeCommit, runs buildBuildings, refuses to overwrite without force, writes temp files then renames. Returns exit code 0 ok, 1 named error, 2 refused overwrite.
 */
export async function runBuildings(
  options: RunOptions,
): Promise<{ code: 0 | 1 | 2; message: string }> {
  const rawPath = join(options.root, 'data/raw/overpass-buildings.json');
  const outPath = join(options.root, 'data/buildings.geojson');
  const replayPath = join(options.root, 'data/buildings.replay.json');
  const temps: string[] = [];
  try {
    const manifest = BuildingsManifestSchema.parse(
      JSON.parse(await readFile(join(options.root, 'data/raw/buildings-manifest.json'), 'utf8')),
    );
    const rawBytes = new Uint8Array(await readFile(rawPath));
    const actual = sha256Hex(rawBytes);
    if (actual !== manifest.sha256)
      fail(
        'PinnedInputHashMismatch',
        `overpass-buildings.json sha256 ${actual} differs from manifest ${manifest.sha256}`,
      );

    const frame: unknown = JSON.parse(
      await readFile(join(options.root, 'data/frame.json'), 'utf8'),
    );
    if (!isDeepStrictEqual(frame, FRAME))
      fail('FrameMismatch', 'data/frame.json differs from the frame in local-frame.ts');

    const resolve =
      options.resolveCommit ?? ((sources, opts) => resolveCodeCommit([...sources], opts));
    const codeCommit = resolve(TRANSFORM_SOURCES, { allowDirty: options.allowDirty });
    const built = buildBuildings(rawBytes, {
      codeCommit,
      toolVersions: readToolVersions(),
      lockSubtreeSha256: lockSubtreeSha256(await readFile(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
      radiusM: options.radiusM ?? null,
    });

    if (!options.force && ((await exists(outPath)) || (await exists(replayPath)))) {
      return {
        code: 2,
        message:
          'OutputExists: data/buildings.geojson or data/buildings.replay.json already exists; pass --force to overwrite',
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
      message: `wrote ${built.collection.features.length} features (${Buffer.byteLength(built.geojsonText)} bytes), ${built.replay.dropped.length} dropped`,
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
      'radius-m': { type: 'string' },
    },
  });
  const radius = values['radius-m'] === undefined ? null : Number(values['radius-m']);
  const started = performance.now();
  const result = await runBuildings({
    root: values.root ?? '.',
    force: values.force === true,
    allowDirty: values['allow-dirty'] === true,
    radiusM: radius,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  (result.code === 0 ? console.log : console.error)(`${result.message}, ${seconds} s`);
  process.exit(result.code);
}

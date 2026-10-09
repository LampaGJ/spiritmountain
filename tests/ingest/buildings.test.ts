import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  buildBuildings,
  parseBuildingConversion,
  ringCentroid,
  runBuildings,
  terrainBox,
  TRANSFORM_SOURCES,
  type BuildContext,
} from '../../scripts/ingest/buildings';
import { BuildingsReplaySchema } from '../../scripts/ingest/buildings-replay-schema';
import { FRAME, osmToLocal } from '../../scripts/ingest/local-frame';
import { sha256Hex } from '../../scripts/ingest/replay';
import { BuildingFeatureCollectionSchema } from '../../src/schema/building';

const CTX: BuildContext = {
  codeCommit: 'a'.repeat(40),
  toolVersions: { osmtogeojson: 'test', proj4: 'test' },
  lockSubtreeSha256: 'c'.repeat(64),
  radiusM: null,
};

/** A closed lon/lat square of half-width d degrees around (lon, lat), as Overpass `out geom` points. */
const square = (lon: number, lat: number, d = 0.0001) =>
  [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ].map(([x, y]) => ({ lat: y as number, lon: x as number }));

const wayEl = (id: number, lon: number, lat: number, tags: Record<string, string>) => ({
  type: 'way',
  id,
  nodes: [1, 2, 3, 4, 1].map((n) => id * 10 + n),
  geometry: square(lon, lat),
  tags,
});

/** Mini pin: a house with levels, a garage, a multipolygon (two outer rings, one with a hole), one way outside the terrain box. */
function mini(extra: unknown[] = []) {
  return {
    version: 0.6,
    generator: 'test',
    osm3s: { timestamp_osm_base: '2026-10-06T00:00:00Z' },
    elements: [
      wayEl(1, -92.215, 46.71, { building: 'detached', 'building:levels': '2', name: 'The House' }),
      wayEl(2, -92.214, 46.71, { building: 'garage' }),
      {
        type: 'relation',
        id: 10,
        members: [
          { type: 'way', ref: 11, role: 'outer', geometry: square(-92.213, 46.711, 0.0002) },
          { type: 'way', ref: 12, role: 'inner', geometry: square(-92.213, 46.711, 0.00005) },
          { type: 'way', ref: 13, role: 'outer', geometry: square(-92.212, 46.711) },
        ],
        tags: { building: 'commercial', type: 'multipolygon' },
      },
      wayEl(3, -92.3, 46.71, { building: 'house' }),
      ...extra,
    ] as Array<Record<string, unknown>>,
  };
}
const bytesOf = (json: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(json)));
const errorName = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).name;
  }
  return 'none';
};

describe('buildBuildings on the mini fixture', () => {
  const result = buildBuildings(bytesOf(mini()), CTX);
  const byId = (id: string) => result.collection.features.find((f) => f.properties.id === id);

  it('keeps the house, the garage and one feature per outer ring, sorted by id', () => {
    expect(result.collection.features.map((f) => f.properties.id)).toEqual([
      'relation/10#0',
      'relation/10#1',
      'way/1',
      'way/2',
    ]);
  });

  it('assigns heights by rule and records the source', () => {
    expect(byId('way/1')?.properties).toMatchObject({
      kind: 'detached',
      name: 'The House',
      heightM: 6,
      levels: 2,
      source: 'levels',
    });
    expect(byId('way/2')?.properties).toMatchObject({ kind: 'garage', heightM: 3.5, levels: null });
    expect(byId('relation/10#0')?.properties).toMatchObject({ kind: 'commercial', heightM: 8 });
  });

  it('keeps the inner ring as a hole on exactly one exploded feature', () => {
    const ringCounts = ['relation/10#0', 'relation/10#1'].map(
      (id) => byId(id)?.geometry.coordinates.length,
    );
    expect(ringCounts.sort()).toEqual([1, 2]);
  });

  it('reprojects through osmToLocal (ITRF2014 to NAD83(2011), #77) and closes every ring', () => {
    const ring = byId('way/1')?.geometry.coordinates[0] ?? [];
    const [x, y] = osmToLocal(-92.215 - 0.0001, 46.71 - 0.0001);
    expect(ring[0]?.[0]).toBeCloseTo(x, 2);
    expect(ring[0]?.[1]).toBeCloseTo(y, 2);
    expect(ring[0]?.[2]).toBe(0);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(BuildingFeatureCollectionSchema.safeParse(result.collection).success).toBe(true);
  });

  it('drops the way outside the terrain box, by name, and accounts for every element', () => {
    expect(result.replay.dropped).toEqual([{ id: 'way/3', reason: 'outside-terrain-box' }]);
    expect(result.replay.counts).toMatchObject({
      inputElements: 4,
      producedElements: 3,
      droppedElements: 1,
      features: 4,
      sourceLevels: 1,
      sourceTypeTable: 3,
    });
    expect(result.replay.droppedCounts).toEqual({ 'outside-terrain-box': 1 });
  });

  it('writes a valid reduces replay record whose outputHash is the geojson hash', () => {
    expect(BuildingsReplaySchema.safeParse(result.replay).success).toBe(true);
    expect(result.replay.effect).toBe('reduces');
    expect(result.replay.inputHash).toBe(sha256Hex(bytesOf(mini())));
    expect(result.replay.outputHash).toBe(sha256Hex(Buffer.from(result.geojsonText, 'utf8')));
    expect(result.replay.terrainBox).toEqual(terrainBox());
  });

  it('is byte-stable: same input twice, and a shuffled element order, give the same bytes', () => {
    const again = buildBuildings(bytesOf(mini()), CTX);
    expect(again.geojsonText).toBe(result.geojsonText);
    expect(again.replayText).toBe(result.replayText);
    const shuffled = mini();
    shuffled.elements.reverse();
    expect(buildBuildings(bytesOf(shuffled), CTX).geojsonText).toBe(result.geojsonText);
  });

  it('does not mutate its input bytes', () => {
    const bytes = bytesOf(mini());
    const before = sha256Hex(bytes);
    buildBuildings(bytes, CTX);
    expect(sha256Hex(bytes)).toBe(before);
  });
});

describe('filters and drops', () => {
  it('--radius-m drops centroids beyond the radius from the frame centre', () => {
    // way/1 is ~0 m from the centre, way/2 ~76 m east, the relation rings ~100 m and ~190 m.
    const r = buildBuildings(bytesOf(mini()), { ...CTX, radiusM: 90 });
    expect(r.collection.features.map((f) => f.properties.id)).toEqual(['way/1', 'way/2']);
    expect(r.replay.droppedCounts).toEqual({ 'outside-radius': 2, 'outside-terrain-box': 1 });
    expect(r.replay.radiusM).toBe(90);
  });

  it('rejects a non-positive radius by name', () => {
    expect(errorName(() => buildBuildings(bytesOf(mini()), { ...CTX, radiusM: 0 }))).toBe(
      'BadArgument',
    );
  });

  it('names building=no, a missing kind and a degenerate ring instead of losing them', () => {
    const r = buildBuildings(
      bytesOf(
        mini([
          wayEl(4, -92.215, 46.712, { building: 'no' }),
          wayEl(5, -92.215, 46.713, { name: 'untyped' }),
          {
            type: 'way',
            id: 6,
            nodes: [61, 62, 63],
            geometry: [
              { lat: 46.71, lon: -92.21 },
              { lat: 46.7101, lon: -92.21 },
              { lat: 46.71, lon: -92.21 },
            ],
            tags: { building: 'shed' },
          },
        ]),
      ),
      CTX,
    );
    const reasons = Object.fromEntries(r.replay.dropped.map((d) => [d.id, d.reason]));
    expect(reasons['way/4']).toBe('building-no');
    expect(reasons['way/5']).toBe('no-kind');
    expect(reasons['way/6']).toBe('no-polygon');
    expect(r.replay.counts['inputElements']).toBe(7);
  });

  it('fails by name, never with an empty result, when the pin has no building tag', () => {
    const renamed = mini();
    for (const el of renamed.elements) {
      const tags = el.tags as Record<string, string> | undefined;
      if (tags) {
        tags['structure'] = tags['building'] as string;
        delete tags['building'];
      }
    }
    expect(errorName(() => buildBuildings(bytesOf(renamed), CTX))).toBe('OverpassMissingFamily');
    expect(errorName(() => buildBuildings(bytesOf({ ...mini(), elements: [] }), CTX))).toBe(
      'OverpassEmpty',
    );
  });

  it('fails by name when osmtogeojson output changes shape', () => {
    expect(errorName(() => parseBuildingConversion({ type: 'Nope' }))).toBe('OsmtogeojsonContract');
    expect(
      errorName(() =>
        parseBuildingConversion({
          type: 'FeatureCollection',
          features: [{ id: 'way/1', geometry: { type: 'Polygon', coordinates: [[['a']]] } }],
        }),
      ),
    ).toBe('OsmtogeojsonContract');
  });
});

describe('ringCentroid and terrainBox', () => {
  it('finds the centroid of a rectangle, and the vertex mean of a zero-area ring', () => {
    const rect: Array<[number, number, number]> = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [0, 2, 0],
      [0, 0, 0],
    ];
    expect(ringCentroid(rect)).toEqual([2, 1]);
    expect(
      ringCentroid([
        [0, 0, 0],
        [2, 0, 0],
        [4, 0, 0],
        [0, 0, 0],
      ]),
    ).toEqual([2, 0]);
  });

  it('terrainBox matches data/terrain.json (origin and extent in local metres)', () => {
    const t = JSON.parse(readFileSync('data/terrain.json', 'utf8')) as {
      originX: number;
      originY: number;
      width: number;
      height: number;
      cellSizeX: number;
      cellSizeY: number;
    };
    const b = terrainBox();
    expect(b.xmin).toBeCloseTo(t.originX, 5);
    expect(b.ymax).toBeCloseTo(t.originY, 5);
    expect(b.xmax - b.xmin).toBeCloseTo(t.width * t.cellSizeX, 5);
    expect(b.ymax - b.ymin).toBeCloseTo(t.height * t.cellSizeY, 5);
  });
});

describe('runBuildings shell', () => {
  function makeRoot(bytes: Uint8Array, manifestSha = sha256Hex(bytes)): string {
    const root = mkdtempSync(join(tmpdir(), 'buildings-'));
    mkdirSync(join(root, 'data/raw'), { recursive: true });
    writeFileSync(join(root, 'data/raw/overpass-buildings.json'), bytes);
    writeFileSync(join(root, 'data/frame.json'), JSON.stringify(FRAME));
    writeFileSync(
      join(root, 'data/raw/buildings-manifest.json'),
      JSON.stringify({
        version: 1,
        name: 'overpass-buildings',
        path: 'data/raw/overpass-buildings.json',
        url: 'https://overpass-api.de/api/interpreter',
        method: 'POST',
        requestBody: 'q',
        requestHeaders: { userAgent: 'x' },
        httpStatus: 200,
        contentType: 'application/json',
        fetchedAt: '2026-10-06T00:00:00.000Z',
        byteLength: bytes.length,
        sha256: manifestSha,
        osm3sTimestampBase: '2026-10-06T00:00:00Z',
        queryFileSha256: 'b'.repeat(64),
        counts: { ways: 3, relations: 1, buildingTagged: 4, manMadeTagged: 0 },
      }),
    );
    return root;
  }
  const opts = (root: string, force = false) => ({
    root,
    force,
    allowDirty: true,
    resolveCommit: () => 'd'.repeat(40),
  });
  const read = (root: string, name: string) => readFileSync(join(root, 'data', name), 'utf8');

  it('writes both files, exits 2 on rerun without force, and replays byte-identically with force', async () => {
    const root = makeRoot(bytesOf(mini()));
    expect((await runBuildings(opts(root))).code).toBe(0);
    const first = [read(root, 'buildings.geojson'), read(root, 'buildings.replay.json')];
    const refused = await runBuildings(opts(root));
    expect(refused.code).toBe(2);
    expect(refused.message).toMatch(/^OutputExists/);
    expect((await runBuildings(opts(root, true))).code).toBe(0);
    expect([read(root, 'buildings.geojson'), read(root, 'buildings.replay.json')]).toEqual(first);
    const replay = BuildingsReplaySchema.parse(JSON.parse(first[1] as string));
    expect(replay.outputHash).toBe(sha256Hex(Buffer.from(first[0] as string, 'utf8')));
  });

  it('exits 1 with PinnedInputHashMismatch when the pin differs from its manifest, writing nothing', async () => {
    const root = makeRoot(bytesOf(mini()), 'e'.repeat(64));
    const result = await runBuildings(opts(root));
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^PinnedInputHashMismatch/);
    expect(existsSync(join(root, 'data/buildings.geojson'))).toBe(false);
  });

  it('exits 1 with FrameMismatch when data/frame.json differs from local-frame.ts', async () => {
    const root = makeRoot(bytesOf(mini()));
    writeFileSync(join(root, 'data/frame.json'), JSON.stringify({ ...FRAME, version: 2 }));
    expect((await runBuildings(opts(root))).message).toMatch(/^FrameMismatch/);
  });
});

/** Every repo file reachable from entry through relative imports (types included), sorted. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of info.importedFiles) {
      if (!fileName.startsWith('.')) continue;
      const base = join(dirname(file), fileName);
      const found = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
      if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
      visit(relative('.', found));
    }
  };
  visit(entry);
  return [...seen].sort();
}

describe('sources', () => {
  const patterns = readFileSync('scripts/determinism-patterns.txt', 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => new RegExp(line));

  it('contain none of the banned determinism hazards', () => {
    for (const file of TRANSFORM_SOURCES.filter((f) => /buildings|building-heights/.test(f))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) expect(text, `${file}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it('the hazard patterns detect a planted hazard (instrument check)', () => {
    expect(patterns.some((p) => p.test('const t = Date.now();'))).toBe(true);
  });

  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of buildings.ts', () => {
    expect([...TRANSFORM_SOURCES].sort()).toEqual(importClosure('scripts/ingest/buildings.ts'));
    expect(TRANSFORM_SOURCES).toContain('scripts/ingest/building-heights.ts');
  });
});

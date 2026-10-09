import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { osmToLocal } from '../../scripts/ingest/local-frame';
import { generatePlaces, PlacesError } from '../../scripts/ingest/places-core';
import { main, PlacesReplaySchema, TRANSFORM_SOURCES } from '../../scripts/ingest/places';
import { sha256Hex } from '../../scripts/ingest/replay';
import { AreaFeatureCollectionSchema } from '../../src/schema/area';
import { PlacesFileSchema, PlacesSeedSchema, type PlaceSeed } from '../../src/schema/places';

const COMMIT = 'a'.repeat(40);
const SEED_PATH = 'scripts/ingest/places.seed.json';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const frameBytes = (): Uint8Array => new Uint8Array(readFileSync('data/frame.json'));
const realAreas = (): Uint8Array => new Uint8Array(readFileSync('data/areas.geojson'));
const realSeed = (): Uint8Array => new Uint8Array(readFileSync(SEED_PATH));

const feature = (
  id: string,
  name: string,
  coordinates: number[][],
  kind: 'lift' | 'snow-park' = 'lift',
) => ({
  type: 'Feature',
  properties: { id, kind, name, difficulty: null, osmTags: {} },
  geometry: { type: 'LineString', coordinates },
});
const areasOf = (...features: unknown[]): Uint8Array =>
  bytes(JSON.stringify({ type: 'FeatureCollection', features }));

const row = (over: Partial<PlaceSeed> & Pick<PlaceSeed, 'id'>): PlaceSeed => ({
  name: over.id,
  kind: 'chalet',
  lat: null,
  lon: null,
  radiusM: 200,
  anchor: null,
  sourceUrl: 'https://example.com/',
  verified: true,
  positionNote: 'test',
  ...over,
});
const seedOf = (...rows: PlaceSeed[]): Uint8Array => bytes(JSON.stringify(rows));

const LIFT = feature('way/1', 'Test Lift', [
  [0, 0, 0],
  [100, 50, 0],
  [300, 400, 0],
]);

function run(rows: PlaceSeed[], areas: Uint8Array = areasOf(LIFT)) {
  return generatePlaces({
    seedBytes: seedOf(...rows),
    areasBytes: areas,
    frameBytes: frameBytes(),
    codeCommit: COMMIT,
  });
}

describe('generatePlaces', () => {
  it('projects coordinates to local metres through the frame, rounded to a centimetre', () => {
    const { file } = run([row({ id: 'a', lat: 46.718, lon: -92.2167 })]);
    const [east, north] = osmToLocal(-92.2167, 46.718);
    expect(file.places[0]?.east).toBe(Math.round(east * 100) / 100);
    expect(file.places[0]?.north).toBe(Math.round(north * 100) / 100);
    expect(file.places[0]?.positionSource).toBe('coordinates');
  });

  it('resolves top as the last vertex, bottom as the first and centroid as the vertex mean', () => {
    const { file } = run([
      row({ id: 'top', anchor: { areaName: 'Test Lift', at: 'top' } }),
      row({ id: 'bottom', anchor: { areaName: 'Test Lift', at: 'bottom' } }),
      row({ id: 'mid', anchor: { areaName: 'Test Lift', at: 'centroid' } }),
    ]);
    const at = (id: string) => file.places.find((p) => p.id === id);
    expect([at('top')?.east, at('top')?.north]).toEqual([300, 400]);
    expect([at('bottom')?.east, at('bottom')?.north]).toEqual([0, 0]);
    expect([at('mid')?.east, at('mid')?.north]).toEqual([133.33, 150]);
    expect(at('top')?.positionSource).toBe('anchor');
  });

  it('puts a placeId anchor exactly on the named place', () => {
    const { file } = run([
      row({ id: 'chalet', lat: 46.7155, lon: -92.2058 }),
      row({ id: 'nordic', anchor: { placeId: 'chalet' } }),
    ]);
    expect([file.places[1]?.east, file.places[1]?.north]).toEqual([
      file.places[0]?.east,
      file.places[0]?.north,
    ]);
  });

  it('keeps an unplaced row as unverified with a null position, in seed order', () => {
    const { file } = run([
      row({ id: 'unplaced', verified: false }),
      row({ id: 'placed', lat: 46.7155, lon: -92.2058 }),
    ]);
    expect(file.places.map((p) => p.id)).toEqual(['unplaced', 'placed']);
    expect(file.places[0]).toMatchObject({
      east: null,
      north: null,
      verified: false,
      positionSource: 'none',
    });
  });

  it('fails with a named error when an anchor names no area, a polygon or several lines', () => {
    const code = (rows: PlaceSeed[], areas: Uint8Array) => {
      try {
        run(rows, areas);
      } catch (error) {
        return error instanceof PlacesError ? error.code : String(error);
      }
      return 'no error';
    };
    expect(code([row({ id: 'x', anchor: { areaName: 'Nope', at: 'top' } })], areasOf(LIFT))).toBe(
      'AnchorAreaMissing',
    );
    const twin = feature('way/2', 'Test Lift', [
      [0, 0, 0],
      [1, 1, 0],
    ]);
    expect(
      code([row({ id: 'x', anchor: { areaName: 'Test Lift', at: 'top' } })], areasOf(LIFT, twin)),
    ).toBe('AnchorNotOneLine');
    const polygon = {
      type: 'Feature',
      properties: { id: 'way/3', kind: 'snow-park', name: 'Park', difficulty: null, osmTags: {} },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0, 0],
            [10, 0, 0],
            [10, 10, 0],
            [0, 0, 0],
          ],
        ],
      },
    };
    expect(
      code([row({ id: 'x', anchor: { areaName: 'Park', at: 'top' } })], areasOf(polygon)),
    ).toBe('AnchorNotOneLine');
  });

  it('fails with FrameMismatch when frame.json differs from the in-code frame', () => {
    const changed = bytes(
      JSON.stringify({
        ...JSON.parse(readFileSync('data/frame.json', 'utf8')),
        centre: { lon: 0, lat: 0 },
      }),
    );
    expect(() =>
      generatePlaces({
        seedBytes: seedOf(row({ id: 'a', lat: 46.7, lon: -92.2 })),
        areasBytes: areasOf(LIFT),
        frameBytes: changed,
        codeCommit: COMMIT,
      }),
    ).toThrow(/FrameMismatch|differs/);
  });

  it('is byte-identical on a second run and its output passes the schema', () => {
    const a = generatePlaces({
      seedBytes: realSeed(),
      areasBytes: realAreas(),
      frameBytes: frameBytes(),
      codeCommit: COMMIT,
    });
    const b = generatePlaces({
      seedBytes: realSeed(),
      areasBytes: realAreas(),
      frameBytes: frameBytes(),
      codeCommit: COMMIT,
    });
    expect(a.fileText).toBe(b.fileText);
    expect(PlacesFileSchema.safeParse(JSON.parse(a.fileText)).success).toBe(true);
  });
});

describe('the committed seed', () => {
  const seed = PlacesSeedSchema.parse(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
  const generated = generatePlaces({
    seedBytes: realSeed(),
    areasBytes: realAreas(),
    frameBytes: frameBytes(),
    codeCommit: COMMIT,
  });

  it('gives every verified place a position and every unverified, unanchored place none', () => {
    for (const place of generated.file.places) {
      expect(place.verified, place.id).toBe(place.east !== null);
    }
    const placeless = seed.filter((r) => r.lat === null && r.anchor === null).map((r) => r.id);
    expect(placeless).toEqual(
      expect.arrayContaining([
        'skills-area',
        'happy-hub',
        'timber-twister-alpine-coaster',
        'timber-flyer-zip-line',
      ]),
    );
    for (const id of placeless) expect(seed.find((r) => r.id === id)?.verified, id).toBe(false);
  });

  it('never marks the Skills Area verified', () => {
    expect(seed.find((r) => r.id === 'skills-area')?.verified).toBe(false);
  });

  it('puts every lift top on the last vertex of its lift way,', () => {
    const areas = AreaFeatureCollectionSchema.parse(
      JSON.parse(readFileSync('data/areas.geojson', 'utf8')),
    );
    const tops = seed.filter((r) => r.kind === 'lift-top');
    expect(tops.length).toBe(8);
    for (const top of tops) {
      const anchor = top.anchor;
      if (anchor === null || !('areaName' in anchor))
        throw new Error(`${top.id} has no area anchor`);
      const lift = areas.features.find((f) => f.properties.name === anchor.areaName);
      const last =
        lift?.geometry.type === 'LineString' ? lift.geometry.coordinates.at(-1) : undefined;
      const place = generated.file.places.find((p) => p.id === top.id);
      expect([place?.east, place?.north], top.id).toEqual([
        Math.round((last?.[0] ?? NaN) * 100) / 100,
        Math.round((last?.[1] ?? NaN) * 100) / 100,
      ]);
    }
  });

  it('places the Nordic Center at Grand on the Grand Avenue Chalet', () => {
    const find = (id: string) => generated.file.places.find((p) => p.id === id);
    expect([find('nordic-center-at-grand')?.east, find('nordic-center-at-grand')?.north]).toEqual([
      find('grand-avenue-chalet')?.east,
      find('grand-avenue-chalet')?.north,
    ]);
  });

  it('keeps a sourceUrl on every row', () => {
    for (const r of seed) expect(r.sourceUrl, r.id).toMatch(/^https?:\/\//);
  });
});

describe('main', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'places-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function go(extra: string[]) {
    let stderr = '';
    const status = await main(['--out', dir, ...extra], {
      resolveCommit: () => COMMIT,
      stdout: () => {},
      stderr: (text) => void (stderr += text),
    });
    return { status, stderr };
  }

  it('writes both files, then refuses to overwrite them without --force', async () => {
    expect((await go([])).status).toBe(0);
    const before = readFileSync(join(dir, 'places.json'), 'utf8');
    const refused = await go([]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/PlacesExist/);
    expect(readFileSync(join(dir, 'places.json'), 'utf8')).toBe(before);
  });

  it('replays byte-identically on --force and the sidecar hashes the output', async () => {
    await go([]);
    const first = ['places.json', 'places.replay.json'].map((n) =>
      readFileSync(join(dir, n), 'utf8'),
    );
    expect((await go(['--force'])).status).toBe(0);
    const second = ['places.json', 'places.replay.json'].map((n) =>
      readFileSync(join(dir, n), 'utf8'),
    );
    expect(second).toEqual(first);
    const replay = PlacesReplaySchema.parse(JSON.parse(first[1] as string));
    expect(replay.outputHash).toBe(sha256Hex(first[0] as string));
    expect(replay.effect).toBe('preserves');
  });

  it('exits 1 with a named error when the seed is missing', async () => {
    const missing = await go(['--seed', join(dir, 'nope.json')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/InputMissing/);
    expect(existsSync(join(dir, 'places.json'))).toBe(false);
  });

  it('exits 1 with SeedInvalid on a seed that fails the schema, writing nothing', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '[{"id":"x"}]');
    const result = await go(['--seed', bad]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SeedInvalid/);
    expect(existsSync(join(dir, 'places.json'))).toBe(false);
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
      const found = [`${base}.ts`, join(base, 'index.ts')].find((candidate) =>
        existsSync(candidate),
      );
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
    for (const file of ['scripts/ingest/places.ts', 'scripts/ingest/places-core.ts']) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) expect(text, `${file}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of places.ts', () => {
    expect([...TRANSFORM_SOURCES].sort()).toEqual(importClosure('scripts/ingest/places.ts'));
  });
});

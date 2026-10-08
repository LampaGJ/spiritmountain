import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AreasReplaySchema } from '../../scripts/ingest/areas-replay-schema';
import {
  buildAreas,
  parseConversion,
  runAreas,
  TRANSFORM_SOURCES,
  type BuildContext,
} from '../../scripts/ingest/areas';
import { BBOX, FRAME, toLocal } from '../../scripts/ingest/local-frame';
import { sha256Hex } from '../../scripts/ingest/replay';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const CTX: BuildContext = {
  codeCommit: 'a'.repeat(40),
  toolVersions: { osmtogeojson: 'test', proj4: 'test' },
  lockSubtreeSha256: 'c'.repeat(64),
};
const fixtureBytes = (): Uint8Array =>
  new Uint8Array(readFileSync('tests/fixtures/overpass-mini.json'));
const fixtureJson = (): { elements: Array<Record<string, unknown>> } =>
  JSON.parse(readFileSync('tests/fixtures/overpass-mini.json', 'utf8'));
const bytesOf = (json: unknown): Uint8Array =>
  new Uint8Array(Buffer.from(JSON.stringify(json), 'utf8'));
const errorName = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).name;
  }
  return 'none';
};

/** Element keys of an Overpass file and the partition identity: producers plus element drops equal inputs, disjoint. */
function assertPartition(raw: Uint8Array): void {
  const input = JSON.parse(Buffer.from(raw).toString('utf8')) as {
    elements: Array<{ type: string; id: number; tags?: Record<string, string> }>;
  };
  const result = buildAreas(raw, CTX);
  const inputKeys = input.elements.map((e) => `${e.type}/${e.id}`).sort(cmp);
  const droppedElements = result.replay.dropped.filter((d) => !d.id.includes('#')).map((d) => d.id);
  const featureIds = result.collection.features.map((f) => f.properties.id);
  const wayElements = input.elements.filter((e) => e.type === 'way').map((e) => `way/${e.id}`);
  const wayProducers = wayElements.filter((id) => featureIds.includes(id));
  const relationProducers = input.elements
    .filter((e) => e.type === 'relation')
    .map((e) => `relation/${e.id}`)
    .filter((id) => !droppedElements.includes(id));
  expect([...wayProducers, ...relationProducers, ...droppedElements].sort(cmp)).toEqual(inputKeys);
  expect(wayProducers.filter((id) => droppedElements.includes(id))).toEqual([]);
  expect(Object.values(result.replay.droppedCounts).reduce((a, b) => a + b, 0)).toBe(
    result.replay.dropped.length,
  );
}

describe('fixture: golden bytes and every drop reason', () => {
  const result = buildAreas(fixtureBytes(), CTX);

  it('matches the golden file byte for byte', () => {
    expect(result.geojsonText).toBe(
      readFileSync('tests/fixtures/areas-mini.expected.geojson', 'utf8'),
    );
  });

  it('records every dropped element with its reason and detail', () => {
    expect(result.replay.dropped).toEqual([
      { id: 'node/7', reason: 'node-pylon' },
      { id: 'node/8', reason: 'node-station' },
      { id: 'node/9', reason: 'node-other', detail: 'no-lift-tag' },
      { id: 'relation/100#node/7', reason: 'unsupported-member', detail: 'member type node' },
      { id: 'relation/100#way/502', reason: 'outside-bbox' },
      {
        id: 'relation/101',
        reason: 'relation-no-new-members',
        detail: 'every member is a way element or was dropped',
      },
      {
        id: 'relation/101#way/501',
        reason: 'duplicate-member',
        detail: 'already exploded from an earlier relation',
      },
      {
        id: 'relation/101#way/503',
        reason: 'unsupported-geometry',
        detail: 'member geometry has fewer than 2 points',
      },
      {
        id: 'relation/102',
        reason: 'relation-no-new-members',
        detail: 'every member is a way element or was dropped',
      },
      { id: 'relation/103', reason: 'relation-unmapped', detail: 'no-recognised-tag' },
      { id: 'way/5', reason: 'unmapped-piste-type', detail: 'piste:type=sled' },
      { id: 'way/6', reason: 'unmapped-tags', detail: 'aerialway=zip_line' },
      { id: 'way/7', reason: 'unmapped-tags', detail: 'no-recognised-tag' },
      { id: 'way/8', reason: 'outside-bbox' },
    ]);
  });

  it('keeps the partition identity: every input element is a feature producer or dropped', () => {
    assertPartition(fixtureBytes());
  });
});

describe('boundary guards', () => {
  it('rejects a file with zero elements by name', () => {
    expect(errorName(() => buildAreas(bytesOf({ ...fixtureJson(), elements: [] }), CTX))).toBe(
      'OverpassEmpty',
    );
  });

  it('rejects a file where a tag family vanished (an upstream rename) by name', () => {
    const json = fixtureJson();
    for (const element of json.elements) {
      const tags = element['tags'] as Record<string, string> | undefined;
      if (tags && 'mtb:scale' in tags) delete tags['mtb:scale'];
    }
    expect(errorName(() => buildAreas(bytesOf(json), CTX))).toBe('OverpassMissingFamily');
  });

  it('rejects an osmtogeojson result that changed shape, by name', () => {
    expect(
      errorName(() =>
        parseConversion({ type: 'FeatureCollection', features: [{ id: 'bad', geometry: null }] }),
      ),
    ).toBe('OsmtogeojsonContract');
    expect(errorName(() => parseConversion({ features: [] }))).toBe('OsmtogeojsonContract');
    expect(errorName(() => parseConversion({ type: 'FeatureCollection', features: [] }))).toBe(
      'none',
    );
  });
});

const PROBE_FILE = 'tests/fixtures/overpass-probe.json';
const PROBE_SHA256 = '3f16e4c0551b467c3da5c2f0f66ae3fc36b2cc806a865729aea8941d376d13e8';
const LIVE_FILE = 'data/raw/overpass.json';

interface RawPoint {
  lat: number;
  lon: number;
}
interface RawElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: RawPoint[];
  members?: Array<{ type: string; ref: number; geometry?: RawPoint[] }>;
}

/**
 * Independent oracle: what the transform should emit, counted straight from the raw Overpass elements.
 * It imports neither kind-mapping.ts nor any transform code (only BBOX), so a bug shared with the
 * transform cannot hide in it. The tag lists below are deliberately retyped, not imported.
 */
function independentCounts(raw: Uint8Array): {
  features: number;
  dropped: number;
  exploded: number;
} {
  const elements = (JSON.parse(Buffer.from(raw).toString('utf8')) as { elements: RawElement[] })
    .elements;
  const pistes = new Set(['downhill', 'snow_park', 'nordic']);
  const lifts = new Set([
    'chair_lift',
    'mixed_lift',
    'gondola',
    'cable_car',
    'drag_lift',
    't-bar',
    'j-bar',
    'platter',
    'rope_tow',
    'magic_carpet',
  ]);
  const wanted = (tags: Record<string, string> = {}): boolean =>
    pistes.has(tags['piste:type'] ?? '') ||
    lifts.has(tags['aerialway'] ?? '') ||
    tags['mtb:scale'] !== undefined ||
    tags['route'] === 'mtb' ||
    tags['route'] === 'hiking';
  const inBox = (points: RawPoint[]): boolean =>
    points.some(
      (p) => p.lat >= BBOX.south && p.lat <= BBOX.north && p.lon >= BBOX.west && p.lon <= BBOX.east,
    );
  const wayIds = new Set(elements.filter((e) => e.type === 'way').map((e) => e.id));
  let features = 0;
  let dropped = 0;
  let exploded = 0;
  for (const element of elements) {
    if (element.type === 'node') dropped += 1;
    else if (element.type === 'way') {
      if (wanted(element.tags) && inBox(element.geometry ?? [])) features += 1;
      else dropped += 1;
    }
  }
  const taken = new Set<number>();
  for (const relation of elements
    .filter((e) => e.type === 'relation')
    .sort((a, b) => a.id - b.id)) {
    if (!wanted(relation.tags)) {
      dropped += 1;
      continue;
    }
    let created = 0;
    for (const member of relation.members ?? []) {
      if (member.type !== 'way') dropped += 1;
      else if (wayIds.has(member.ref)) continue;
      else if (taken.has(member.ref)) dropped += 1;
      else if ((member.geometry ?? []).length < 2 || !inBox(member.geometry ?? [])) dropped += 1;
      else {
        taken.add(member.ref);
        features += 1;
        exploded += 1;
        created += 1;
      }
    }
    if (created === 0) dropped += 1;
  }
  return { features, dropped, exploded };
}

describe.each([
  ['probe file', PROBE_FILE],
  ['live pin', LIVE_FILE],
])('%s', (_label, file) => {
  const raw = new Uint8Array(readFileSync(file));
  const result = buildAreas(raw, CTX);
  const rawWayKeys = new Set(
    (JSON.parse(Buffer.from(raw).toString('utf8')) as { elements: RawElement[] }).elements
      .filter((e) => e.type === 'way')
      .map((e) => `way/${e.id}`),
  );

  it('keeps the partition identity', () => {
    assertPartition(raw);
  });

  it('emits no relation/ feature, all ids unique, all z 0', () => {
    expect(result.collection.features.length).toBeGreaterThan(0);
    const ids = result.collection.features.map((f) => f.properties.id);
    expect(ids.some((id) => id.startsWith('relation/'))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    // hiking-trail ways may run kilometres past the bbox (275 mi route, #48 step 6): any vertex inside keeps the way, the radial fade hides the rest.
    const coords = result.collection.features
      .filter((f) => f.properties.kind !== 'hiking-trail')
      .flatMap((f) =>
        f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat(),
      );
    expect(coords.every((p) => p[2] === 0)).toBe(true);
  });

  it('keeps every coordinate within the bbox corners (through toLocal) plus a 500 m margin for partly outside ways', () => {
    const [x0, y0] = toLocal(BBOX.west, BBOX.south);
    const [x1, y1] = toLocal(BBOX.east, BBOX.north);
    const pad = 500;
    // hiking-trail ways may run kilometres past the bbox (275 mi route, #48 step 6): any vertex inside keeps the way, the radial fade hides the rest.
    const coords = result.collection.features
      .filter((f) => f.properties.kind !== 'hiking-trail')
      .flatMap((f) =>
        f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat(),
      );
    expect(coords.length).toBeGreaterThan(0);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(Math.min(x0, x1) - pad);
      expect(x).toBeLessThanOrEqual(Math.max(x0, x1) + pad);
      expect(y).toBeGreaterThanOrEqual(Math.min(y0, y1) - pad);
      expect(y).toBeLessThanOrEqual(Math.max(y0, y1) + pad);
    }
  });

  // Fails with a delta (vitest prints both objects) when the transform and the raw bytes disagree. It always runs.
  it('agrees with the independent raw-element counter', () => {
    const exploded = result.collection.features.filter((f) => !rawWayKeys.has(f.properties.id));
    expect({
      features: result.collection.features.length,
      dropped: result.replay.dropped.length,
      exploded: exploded.length,
    }).toEqual(independentCounts(raw));
  });
});

describe('probe file (tests/fixtures/overpass-probe.json, committed by this issue)', () => {
  const raw = new Uint8Array(readFileSync(PROBE_FILE));
  const result = buildAreas(raw, CTX);

  it('is the recorded probe: 242,146 bytes and the recorded sha256', () => {
    expect(raw.byteLength).toBe(242_146);
    expect(sha256Hex(raw)).toBe(PROBE_SHA256);
  });

  it('matches the probe counts exactly', () => {
    expect(result.replay.counts).toEqual({
      'downhill-run': 21,
      'hiking-trail': 0,
      lift: 8,
      'mtb-route': 29,
      'mtb-trail': 15,
      'nordic-trail': 40,
      'snow-park': 2,
    });
    expect(result.collection.features).toHaveLength(115);
    expect(result.replay.droppedCounts).toEqual({ 'node-pylon': 23, 'node-station': 2 });
    expect(result.replay.dropped).toHaveLength(25);
    // Relation 15994736 has 29 member ways and none is a way element: all 29 must be exploded.
    const exploded = result.collection.features.filter(
      (f) => f.properties.osmTags['route:name'] === 'Spirit Mountain Bike Park',
    );
    expect(exploded).toHaveLength(29);
    // Relation 20254390 has 4 members; 3 are way elements, 1 is exploded as nordic-trail.
    expect(
      result.collection.features.filter(
        (f) => f.properties.osmTags['route:name'] === 'Nordic Connector Trail',
      ),
    ).toHaveLength(1);
  });
});

describe('shell: runAreas', () => {
  function makeRoot(raw: Uint8Array, manifestSha?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'areas-'));
    mkdirSync(join(root, 'data/raw'), { recursive: true });
    writeFileSync(join(root, 'data/raw/overpass.json'), raw);
    // Start from the real pinned manifest (#7) so ManifestSchema accepts it; only the overpass hash changes.
    const manifest = JSON.parse(readFileSync('data/raw/manifest.json', 'utf8'));
    manifest.overpass.sha256 = manifestSha ?? sha256Hex(raw);
    writeFileSync(join(root, 'data/raw/manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'data/frame.json'), JSON.stringify(FRAME));
    return root;
  }
  const opts = (root: string, force = false) => ({
    root,
    force,
    allowDirty: false,
    resolveCommit: () => 'b'.repeat(40),
  });
  const read = (root: string, name: string): Buffer => readFileSync(join(root, 'data', name));

  it('writes both files, replays to identical bytes, and hashes the exact bytes on disk', async () => {
    const root = makeRoot(fixtureBytes());
    expect((await runAreas(opts(root))).code).toBe(0);
    const first = read(root, 'areas.geojson');
    const firstReplay = read(root, 'areas.replay.json');
    expect((await runAreas(opts(root, true))).code).toBe(0);
    expect(sha256Hex(read(root, 'areas.geojson'))).toBe(sha256Hex(first));
    expect(read(root, 'areas.replay.json').equals(firstReplay)).toBe(true);
    const replay = AreasReplaySchema.parse(JSON.parse(firstReplay.toString('utf8')));
    expect(replay.outputHash).toBe(sha256Hex(first));
    expect(replay.codeCommit).toBe('b'.repeat(40));
    expect(first.toString('utf8').endsWith('}\n')).toBe(true);
    expect(first.includes(13)).toBe(false);
  });

  it('refuses to overwrite without --force (exit 2) and changes nothing', async () => {
    const root = makeRoot(fixtureBytes());
    await runAreas(opts(root));
    const before = read(root, 'areas.geojson');
    const result = await runAreas(opts(root));
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/^OutputExists/);
    expect(read(root, 'areas.geojson').equals(before)).toBe(true);
  });

  it('exits 1 with PinnedInputHashMismatch on a flipped byte and writes nothing', async () => {
    const tampered = Buffer.from(fixtureBytes());
    const last = tampered.lastIndexOf('0');
    tampered[last] = 49;
    const root = makeRoot(tampered, sha256Hex(fixtureBytes()));
    const result = await runAreas(opts(root));
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^PinnedInputHashMismatch/);
    expect(() => read(root, 'areas.geojson')).toThrow();
    expect(() => read(root, 'areas.replay.json')).toThrow();
  });

  it('exits 1 with FrameMismatch when data/frame.json differs from local-frame.ts', async () => {
    const root = makeRoot(fixtureBytes());
    writeFileSync(join(root, 'data/frame.json'), JSON.stringify({ ...FRAME, version: 2 }));
    const result = await runAreas(opts(root));
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^FrameMismatch/);
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
  const files = ['areas.ts', 'areas-replay-schema.ts', 'areas-serialize.ts', 'kind-mapping.ts'].map(
    (f) => `scripts/ingest/${f}`,
  );
  // The one pattern list (#5): the lint script, its test, this scan and #15's sweep all read it.
  const patterns = readFileSync('scripts/determinism-patterns.txt', 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => new RegExp(line));

  it('contain none of the banned determinism hazards', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) expect(text, `${file}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of areas.ts', () => {
    expect([...TRANSFORM_SOURCES].sort()).toEqual(importClosure('scripts/ingest/areas.ts'));
  });
});

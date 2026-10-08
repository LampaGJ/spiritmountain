import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AnnotationsError,
  buildAnnotations,
  checkEmittedFile,
  compareCodeUnit,
  generateAnnotations,
  parseAreas,
  parseSeed,
  serialize,
  stakeholdersFor,
} from '../../scripts/ingest/annotations-core';
import { sha256Hex } from '../../scripts/ingest/replay';
import { AnnotationsFileSchema } from '../../src/schema/annotations-file';
import { OrganizationSchema } from '../../src/schema/organization';
import { GeneratedFromSchema, ReplayRecordSchema } from '../../src/schema/replay';
import {
  AREA_ROWS,
  FAKE_COMMIT,
  areasBytes,
  areasFileObject,
  bytesOf,
  realSeedBytes,
  realSeedRows,
} from './annotations-fixtures';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof AnnotationsError) return cause.code;
    throw cause;
  }
  return 'NO_ERROR';
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  return '';
}

function keysAtAnyDepth(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysAtAnyDepth(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysAtAnyDepth(child, into);
    }
  }
  return into;
}

const seed = parseSeed(realSeedBytes());
const areas = parseAreas(areasBytes());
const built = buildAnnotations(areas, seed);

describe('gate: the real seed file parses through #6 OrganizationSchema, unchanged', () => {
  it('every row passes z.array(OrganizationSchema) with no transformation', () => {
    expect(z.array(OrganizationSchema).safeParse(realSeedRows()).success).toBe(true);
  });
});

describe('kind defaults (one case per kind)', () => {
  const cases: [string, string, { activity: string; seasons: string[]; sourced?: boolean }[]][] = [
    [
      'downhill-run',
      'way/999',
      [
        { activity: 'alpine-ski', seasons: ['winter', 'spring'] },
        { activity: 'snowboard', seasons: ['winter', 'spring'] },
        { activity: 'adaptive', seasons: ['winter', 'spring'], sourced: true },
      ],
    ],
    [
      'snow-park',
      'way/30',
      [
        { activity: 'alpine-ski', seasons: ['winter', 'spring'] },
        { activity: 'snowboard', seasons: ['winter', 'spring'] },
        { activity: 'adaptive', seasons: ['winter', 'spring'], sourced: true },
      ],
    ],
    [
      'nordic-trail',
      'way/1000',
      [
        { activity: 'nordic-classic', seasons: ['winter'] },
        { activity: 'nordic-skate', seasons: ['winter'] },
        { activity: 'snowshoe', seasons: ['winter'], sourced: true },
      ],
    ],
    [
      'mtb-trail',
      'way/20',
      [
        { activity: 'mountain-bike', seasons: ['spring', 'summer', 'fall'] },
        { activity: 'hike', seasons: ['spring', 'summer', 'fall'], sourced: true },
        { activity: 'trail-run', seasons: ['spring', 'summer', 'fall'], sourced: true },
        { activity: 'fat-bike', seasons: ['winter'], sourced: true },
      ],
    ],
    [
      'mtb-route',
      'relation/5',
      [
        { activity: 'mountain-bike', seasons: ['spring', 'summer', 'fall'] },
        { activity: 'hike', seasons: ['spring', 'summer', 'fall'], sourced: true },
        { activity: 'trail-run', seasons: ['spring', 'summer', 'fall'], sourced: true },
        { activity: 'fat-bike', seasons: ['winter'], sourced: true },
      ],
    ],
    ['lift', 'way/7', [{ activity: 'lift-ride', seasons: ['winter'] }]],
    [
      'hiking-trail',
      'way/40',
      [
        { activity: 'hike', seasons: ['spring', 'summer', 'fall'] },
        { activity: 'trail-run', seasons: ['spring', 'summer', 'fall'] },
      ],
    ],
  ];
  it.each(cases)('%s', (_kind, id, expected) => {
    const annotation = built.annotations.find((a) => a.areaId === id);
    expect(annotation?.activities.map(({ activity, seasons }) => ({ activity, seasons }))).toEqual(
      expected.map(({ activity, seasons }) => ({ activity, seasons })),
    );
    expected.forEach((e, i) => {
      const notes = annotation?.activities[i]?.notes ?? '';
      if (e.sourced === true) expect(notes).toMatch(/ \(https:\/\/\S+\)$/);
      else expect(notes).toBe('derived from OSM kind');
      expect(notes).not.toMatch(/inferred/i);
    });
  });
  it('the fixture covers seven of the eight kinds (tubing-run is derived)', () => {
    expect(new Set(AREA_ROWS.map((r) => r.kind)).size).toBe(7);
  });
  it('every annotation has empty notes', () => {
    expect(built.annotations.every((a) => a.notes === '')).toBe(true);
  });
  it('rejects a kind with no rule (reachable only through a cast, since the area schema already rejects unknown kinds)', () => {
    const bad = [{ id: 'way/1', kind: 'ski-jump' }] as unknown as Parameters<
      typeof buildAnnotations
    >[0];
    expect(codeOf(() => buildAnnotations(bad, seed))).toBe('UnmappedKind');
  });
});

describe('ordering and byte-stable shape', () => {
  it('sorts by areaId in code-unit order (way/1000 before way/999) and equals the sorted feature order', () => {
    const ids = built.annotations.map((a) => a.areaId);
    expect(ids).toEqual([
      'relation/5',
      'way/1000',
      'way/20',
      'way/30',
      'way/40',
      'way/7',
      'way/999',
    ]);
    expect(ids).toEqual([...AREA_ROWS.map((r) => r.id)].sort(compareCodeUnit));
  });
  it('lists activities and seasons in rule order, not sorted', () => {
    const mtb = built.annotations.find((a) => a.areaId === 'way/20');
    expect(mtb?.activities[0]?.seasons).toEqual(['spring', 'summer', 'fall']);
  });
  it('serializes every object kind with a literal key order', () => {
    const file = generateAnnotations({
      areasBytes: areasBytes(),
      seedBytes: realSeedBytes(),
      codeCommit: FAKE_COMMIT,
    }).file;
    expect(Object.keys(file)).toEqual(['version', 'generatedFrom', 'organizations', 'annotations']);
    expect(Object.keys(file.generatedFrom)).toEqual(['inputHash', 'codeCommit', 'effect']);
    expect(Object.keys(file.organizations[0] ?? {})).toEqual([
      'id',
      'name',
      'url',
      'type',
      'activities',
      'sourceUrl',
      'verified',
    ]);
    expect(Object.keys(file.annotations[0] ?? {})).toEqual([
      'areaId',
      'activities',
      'stakeholders',
      'notes',
    ]);
    expect(Object.keys(file.annotations[0]?.activities[0] ?? {})).toEqual([
      'activity',
      'seasons',
      'notes',
    ]);
  });
  it('uses 2-space JSON, LF only, one trailing newline', () => {
    const text = serialize({ a: [1] });
    expect(text).toBe('{\n  "a": [\n    1\n  ]\n}\n');
    expect(text.includes('\r')).toBe(false);
  });
});

describe('organizations are carried through unchanged', () => {
  it('has as many organizations as the seed, with identical ids, verified flags and every other field', () => {
    const rows = realSeedRows();
    expect(built.organizations.length).toBe(rows.length);
    const byId = new Map(rows.map((row) => [row['id'], row]));
    for (const org of built.organizations) expect(org).toEqual(byId.get(org.id));
    expect(new Set(built.organizations.map((o) => o.id))).toEqual(
      new Set(rows.map((r) => r['id'])),
    );
  });
  it('keeps unverified rows, empty sourceUrl and null url as the seed has them (COGGS url stays null)', () => {
    expect(built.organizations.some((o) => !o.verified)).toBe(true);
    expect(built.organizations.some((o) => o.sourceUrl === '')).toBe(true);
    expect(built.organizations.find((o) => o.name.includes('COGGS'))?.url).toBeNull();
  });
  it('rejects a duplicate organization id and a duplicate area id', () => {
    const first = seed[0];
    if (first === undefined) throw new Error('seed is empty');
    expect(codeOf(() => buildAnnotations(areas, [...seed, first]))).toBe('DuplicateOrgId');
    const firstArea = areas[0];
    if (firstArea === undefined) throw new Error('areas is empty');
    expect(codeOf(() => buildAnnotations([...areas, firstArea], seed))).toBe('DuplicateAreaId');
  });
  it('flags a violated effect when there are no organizations (expands needs more items out than in)', () => {
    expect(codeOf(() => buildAnnotations(areas, []))).toBe('EffectViolated');
  });
});

describe('boundary parse of the seed (the instrument detects bad seeds)', () => {
  const rows = realSeedRows();
  it('names both the unknown key and the missing field for a renamed key', () => {
    const renamed = rows.map(({ verified, ...rest }) => ({ ...rest, verifed: verified }));
    const message = messageOf(() => parseSeed(bytesOf(renamed)));
    expect(codeOf(() => parseSeed(bytesOf(renamed)))).toBe('SeedInvalid');
    expect(message).toContain('verifed');
    expect(message).toContain('verified');
    expect(message).toContain('row 0');
  });
  it('rejects a row missing activities and a row with an unknown type', () => {
    const noActivities = Object.fromEntries(
      Object.entries(rows[0] ?? {}).filter(([key]) => key !== 'activities'),
    );
    expect(codeOf(() => parseSeed(bytesOf([noActivities])))).toBe('SeedInvalid');
    expect(codeOf(() => parseSeed(bytesOf([{ ...rows[0], type: 'agency' }])))).toBe('SeedInvalid');
  });
  it('rejects an empty array as NoOrganizations', () => {
    expect(codeOf(() => parseSeed(bytesOf([])))).toBe('NoOrganizations');
  });
  it('rejects a truncated file and a byte-order mark as SeedNotJson', () => {
    const text = JSON.stringify(rows);
    expect(codeOf(() => parseSeed(new TextEncoder().encode(text.slice(0, text.length - 5))))).toBe(
      'SeedNotJson',
    );
    expect(codeOf(() => parseSeed(new TextEncoder().encode('\uFEFF' + text)))).toBe('SeedNotJson');
  });
});

describe('boundary parse of the areas file', () => {
  it('rejects zero features as NoAreas', () => {
    expect(codeOf(() => parseAreas(bytesOf({ type: 'FeatureCollection', features: [] })))).toBe(
      'NoAreas',
    );
  });
  it('rejects a renamed field as AreasInvalid and a truncated file as AreasNotJson', () => {
    const { features, ...rest } = areasFileObject();
    expect(codeOf(() => parseAreas(bytesOf({ ...rest, items: features })))).toBe('AreasInvalid');
    expect(codeOf(() => parseAreas(new TextEncoder().encode('{"type":')))).toBe('AreasNotJson');
  });
});

describe('emitter-side reference check on doctored files', () => {
  const good = generateAnnotations({
    areasBytes: areasBytes(),
    seedBytes: realSeedBytes(),
    codeCommit: FAKE_COMMIT,
  }).file;
  const ids = new Set(areas.map((a) => a.id));
  const clone = () => structuredClone(good);
  it('passes the real file', () => {
    expect(codeOf(() => checkEmittedFile(good, ids))).toBe('NO_ERROR');
  });
  it('reports an annotation whose areaId is not in the areas', () => {
    const doctored = clone();
    const first = doctored.annotations[0];
    if (first === undefined) throw new Error('no annotations');
    first.areaId = 'way/424242';
    expect(codeOf(() => checkEmittedFile(doctored, ids))).toBe('AnnotationsInvalid');
  });
  it('reports a stakeholder orgId that matches no organization', () => {
    const doctored = clone();
    doctored.annotations[0]?.stakeholders.push({ orgId: 'no-such-org', role: 'funds' });
    expect(codeOf(() => checkEmittedFile(doctored, ids))).toBe('AnnotationsInvalid');
  });
  it('reports a duplicate areaId', () => {
    const doctored = clone();
    const first = doctored.annotations[0];
    if (first === undefined) throw new Error('no annotations');
    doctored.annotations.push(structuredClone(first));
    expect(codeOf(() => checkEmittedFile(doctored, ids))).toBe('AnnotationsInvalid');
  });
  it('reports an area with no annotation', () => {
    const doctored = clone();
    doctored.annotations.pop();
    expect(codeOf(() => checkEmittedFile(doctored, ids))).toBe('MissingAnnotation');
  });
});

describe('generateAnnotations: replay record and generatedFrom', () => {
  const input = { areasBytes: areasBytes(), seedBytes: realSeedBytes(), codeCommit: FAKE_COMMIT };
  const run = generateAnnotations(input);
  const replay: unknown = JSON.parse(run.replayText);

  it('is byte-identical across two runs', () => {
    const again = generateAnnotations(input);
    expect(sha256Hex(again.fileText)).toBe(sha256Hex(run.fileText));
    expect(again.replayText).toBe(run.replayText);
  });
  it('parses through AnnotationsFileSchema and the sidecar through ReplayRecordSchema', () => {
    expect(AnnotationsFileSchema.safeParse(JSON.parse(run.fileText)).success).toBe(true);
    expect(ReplayRecordSchema.safeParse(replay).success).toBe(true);
  });
  it('sidecar outputHash is the sha256 of the file bytes, and effect is expands', () => {
    const record = ReplayRecordSchema.parse(replay);
    expect(record.outputHash).toBe(sha256Hex(run.fileText));
    expect(record.effect).toBe('expands');
    expect(record.codeCommit).toBe(FAKE_COMMIT);
  });
  it('generatedFrom parses with GeneratedFromSchema, has no outputHash, and shares inputHash, codeCommit and effect with the sidecar', () => {
    const record = ReplayRecordSchema.parse(replay);
    const stamp = run.file.generatedFrom;
    expect(GeneratedFromSchema.safeParse(JSON.parse(run.fileText).generatedFrom).success).toBe(
      true,
    );
    expect('outputHash' in stamp).toBe(false);
    expect(stamp.inputHash).toBe(record.inputHash);
    expect(stamp.codeCommit).toBe(record.codeCommit);
    expect(stamp.effect).toBe(record.effect);
  });
  it('contains no outputHash key anywhere in annotations.json (it lives only in the sidecar)', () => {
    expect(keysAtAnyDepth(JSON.parse(run.fileText)).has('outputHash')).toBe(false);
  });
  it('inputHash changes when either input changes', () => {
    const other = generateAnnotations({ ...input, areasBytes: areasBytes(AREA_ROWS.slice(0, 5)) });
    expect(other.file.generatedFrom.inputHash).not.toBe(run.file.generatedFrom.inputHash);
  });
  it('contains no timestamp key at any depth', () => {
    const keys = keysAtAnyDepth(JSON.parse(run.fileText));
    for (const banned of ['runAt', 'fetchedAt', 'toolVersions'])
      expect(keys.has(banned)).toBe(false);
  });
});

describe('stakeholder rule', () => {
  const entry = (activity: string) => ({ activity, seasons: [], notes: '' }) as never;
  const ids = (links: { orgId: string }[]) => links.map((l) => l.orgId);
  const AUTHORITY = 'spirit-mountain-recreation-area-authority';

  it('a lift gets only the Authority, as operator', () => {
    const lift = built.annotations.find((a) => a.areaId === 'way/7');
    expect(lift?.stakeholders).toEqual([{ orgId: AUTHORITY, role: 'operates' }]);
  });
  it('a mountain-bike area gets COGGS, the DEVO program and the City, and not the unverified high-school league', () => {
    const mtb = built.annotations.find((a) => a.areaId === 'way/20');
    const got = ids(mtb?.stakeholders ?? []);
    for (const id of [
      'cyclists-of-gitchee-gumee-shores',
      'duluth-devo-mountain-bike-program',
      'city-of-duluth-parks-and-recreation',
      AUTHORITY,
    ])
      expect(got).toContain(id);
    expect(got).not.toContain('minnesota-high-school-cycling-league');
    expect(got).not.toContain('duluth-cross-country-ski-club');
  });
  it('never assigns an unverified org, even when its activities match', () => {
    const unverified = seed.filter(
      (org) => !org.verified && org.activities.includes('mountain-bike'),
    );
    expect(unverified.length).toBeGreaterThan(0);
    expect(ids(stakeholdersFor([entry('mountain-bike')], seed))).not.toContain(unverified[0]?.id);
    const fake = { ...seed[0], id: 'zz-fake', activities: ['mountain-bike'], verified: false };
    expect(ids(stakeholdersFor([entry('mountain-bike')], [...seed, fake as never]))).not.toContain(
      'zz-fake',
    );
    for (const annotation of built.annotations)
      for (const link of annotation.stakeholders)
        expect(built.organizations.find((o) => o.id === link.orgId)?.verified).toBe(true);
  });
  it('sorts by org id in code-unit order, one link per org', () => {
    for (const annotation of built.annotations) {
      const got = ids(annotation.stakeholders);
      expect(got).toEqual([...got].sort(compareCodeUnit));
      expect(new Set(got).size).toBe(got.length);
      expect(got).toContain(AUTHORITY);
    }
  });
  it('is deterministic and independent of seed order', () => {
    const forward = stakeholdersFor([entry('mountain-bike')], seed);
    const reversed = stakeholdersFor([entry('mountain-bike')], [...seed].reverse());
    expect(reversed).toEqual(forward);
  });
  it('uses only roles the schema allows', () => {
    const roles = new Set(built.annotations.flatMap((a) => a.stakeholders.map((s) => s.role)));
    for (const role of roles)
      expect(['maintains', 'operates', 'programs', 'funds', 'advocates']).toContain(role);
  });
});

describe('activity audit rules (#69)', () => {
  const rows = [
    { id: 'way/501', kind: 'lift', name: 'Tubing Hill Handle Tow' },
    { id: 'way/502', kind: 'lift', name: 'Spirit Express II' },
    { id: 'way/503', kind: 'lift', name: 'Summit Chair' },
    { id: 'way/504', kind: 'lift', name: null },
    { id: 'derived/tubing-run/way/501', kind: 'tubing-run', name: 'Tubing Hill' },
  ] as const;
  const result = buildAnnotations(rows, seed);
  const activitiesOf = (id: string) => result.annotations.find((a) => a.areaId === id)?.activities;

  it('a lift named like tubing carries lift-ride and tubing, both winter, with a sourced note on tubing', () => {
    const entries = activitiesOf('way/501');
    expect(entries?.map((e) => [e.activity, e.seasons])).toEqual([
      ['lift-ride', ['winter']],
      ['tubing', ['winter']],
    ]);
    expect(entries?.[1]?.notes).toMatch(/ \(https:\/\/\S+\)$/);
  });
  it('Spirit Express II carries lift-ride in winter and summer with a sourced note; other lifts are winter only', () => {
    const express = activitiesOf('way/502');
    expect(express).toHaveLength(1);
    expect(express?.[0]?.seasons).toEqual(['winter', 'summer']);
    expect(express?.[0]?.notes).toMatch(/ \(https:\/\/\S+\)$/);
    expect(activitiesOf('way/503')).toEqual([
      { activity: 'lift-ride', seasons: ['winter'], notes: 'derived from OSM kind' },
    ]);
    expect(activitiesOf('way/504')?.[0]?.seasons).toEqual(['winter']);
  });
  it('a tubing-run carries tubing in winter', () => {
    expect(activitiesOf('derived/tubing-run/way/501')?.map((e) => [e.activity, e.seasons])).toEqual(
      [['tubing', ['winter']]],
    );
  });
  it('accepts the derived id through the whole generator (areas file parse, emitter gate)', () => {
    const out = generateAnnotations({
      areasBytes: areasBytes([
        { id: 'way/501', kind: 'lift' },
        { id: 'derived/tubing-run/way/501', kind: 'tubing-run' },
      ]),
      seedBytes: realSeedBytes(),
      codeCommit: FAKE_COMMIT,
    });
    expect(out.file.annotations.map((a) => a.areaId)).toEqual([
      'derived/tubing-run/way/501',
      'way/501',
    ]);
  });
  it('all twelve activities are carried by some rule', () => {
    const file = generateAnnotations({
      areasBytes: areasBytes([
        ...AREA_ROWS,
        { id: 'way/501', kind: 'lift' },
        { id: 'derived/tubing-run/way/501', kind: 'tubing-run' },
      ]),
      seedBytes: realSeedBytes(),
      codeCommit: FAKE_COMMIT,
    }).file;
    const carried = new Set(file.annotations.flatMap((a) => a.activities.map((e) => e.activity)));
    expect(carried.size).toBe(12);
  });
  it('no note says inferred', () => {
    const all = result.annotations.flatMap((a) => a.activities.map((e) => e.notes));
    expect(all.some((note) => /inferred/i.test(note))).toBe(false);
  });
});

describe('each sourced rule cites its original page (#69)', () => {
  const rows = [
    { id: 'way/1', kind: 'downhill-run', name: null },
    { id: 'way/2', kind: 'nordic-trail', name: null },
    { id: 'way/3', kind: 'mtb-trail', name: null },
    { id: 'way/4', kind: 'lift', name: 'Spirit Express II' },
    { id: 'way/5', kind: 'lift', name: 'Tubing Hill Handle Tow' },
  ] as const;
  const result = buildAnnotations(rows, seed);
  const noteOf = (id: string, activity: string): string =>
    result.annotations.find((a) => a.areaId === id)?.activities.find((e) => e.activity === activity)
      ?.notes ?? '';
  it.each([
    ['way/1', 'adaptive', 'https://spiritmt.com/?p=34'],
    ['way/2', 'snowshoe', 'https://spiritmt.com/winter/nordic/'],
    ['way/3', 'fat-bike', 'https://spiritmt.com/winter/downhill/'],
    ['way/3', 'hike', 'https://coggs.com/'],
    ['way/3', 'trail-run', 'https://coggs.com/'],
    ['way/4', 'lift-ride', 'https://spiritmt.com/summer/adventure-park/'],
    ['way/5', 'tubing', 'https://spiritmt.com/winter/tubing/'],
  ])('%s %s', (id, activity, url) => {
    expect(noteOf(id, activity).endsWith(`(${url})`)).toBe(true);
  });
  it('states the gaps on the page: months not stated, trails not specified', () => {
    expect(noteOf('way/4', 'lift-ride')).toContain('months not stated');
    expect(noteOf('way/2', 'snowshoe')).toContain('trails not specified on the page');
    expect(noteOf('way/3', 'fat-bike')).toContain('trails not specified on the page');
  });
});

describe('Adventure Park kinds (#71)', () => {
  const rows = [
    { id: 'way/801', kind: 'zip-line' },
    { id: 'way/802', kind: 'campground' },
    { id: 'way/803', kind: 'climbing' },
    { id: 'way/804', kind: 'attraction' },
  ];
  const out = generateAnnotations({
    areasBytes: areasBytes(rows),
    seedBytes: realSeedBytes(),
    codeCommit: FAKE_COMMIT,
  }).file;
  const of = (id: string) => out.annotations.find((a) => a.areaId === id);

  it('gives the zip line the summer-only zip-line activity, sourced to the Adventure Park page', () => {
    expect(of('way/801')?.activities).toEqual([
      {
        activity: 'zip-line',
        seasons: ['summer'],
        notes:
          'zip line in the summer Adventure Park (https://spiritmt.com/summer/adventure-park/)',
      },
    ]);
  });

  it('gives the campground camping in spring, summer and fall, sourced to the camping page', () => {
    expect(of('way/802')?.activities).toEqual([
      {
        activity: 'camping',
        seasons: ['spring', 'summer', 'fall'],
        notes: 'campground open May 20 to Oct 25 2026 (https://spiritmt.com/summer/camping/)',
      },
    ]);
  });

  it('assigns no activity to climbing, because no source names one', () => {
    expect(of('way/803')?.activities).toEqual([]);
  });

  it('gives an attraction the summer-only alpine-coaster activity with the Cloudflare caveat in its note', () => {
    expect(of('way/804')?.activities).toEqual([
      {
        activity: 'alpine-coaster',
        seasons: ['summer'],
        notes:
          'Timber Twister Alpine Coaster; page blocked by Cloudflare at fetch time, cited from issue #71 (https://spiritmt.com/summer/adventure-park/)',
      },
    ]);
  });

  it('still annotates every area, so none is missing', () => {
    expect(out.annotations.map((a) => a.areaId)).toEqual([
      'way/801',
      'way/802',
      'way/803',
      'way/804',
    ]);
  });
});

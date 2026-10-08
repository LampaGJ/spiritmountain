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
  const cases: [string, string, { activity: string; seasons: string[] }[]][] = [
    [
      'downhill-run',
      'way/999',
      [
        { activity: 'alpine-ski', seasons: ['winter', 'spring'] },
        { activity: 'snowboard', seasons: ['winter', 'spring'] },
      ],
    ],
    [
      'snow-park',
      'way/30',
      [
        { activity: 'alpine-ski', seasons: ['winter', 'spring'] },
        { activity: 'snowboard', seasons: ['winter', 'spring'] },
      ],
    ],
    [
      'nordic-trail',
      'way/1000',
      [
        { activity: 'nordic-classic', seasons: ['winter'] },
        { activity: 'nordic-skate', seasons: ['winter'] },
      ],
    ],
    ['mtb-trail', 'way/20', [{ activity: 'mountain-bike', seasons: ['spring', 'summer', 'fall'] }]],
    [
      'mtb-route',
      'relation/5',
      [{ activity: 'mountain-bike', seasons: ['spring', 'summer', 'fall'] }],
    ],
    ['lift', 'way/7', [{ activity: 'lift-ride', seasons: [] }]],
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
    expect(annotation?.activities).toEqual(
      expected.map((e) => ({ ...e, notes: 'derived from OSM kind' })),
    );
  });
  it('the fixture covers all seven kinds', () => {
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
  it('a mountain-bike area gets COGGS, the DEVO program, the high-school league and the City', () => {
    const mtb = built.annotations.find((a) => a.areaId === 'way/20');
    const got = ids(mtb?.stakeholders ?? []);
    for (const id of [
      'cyclists-of-gitchee-gumee-shores',
      'duluth-devo-mountain-bike-program',
      'minnesota-high-school-cycling-league',
      'city-of-duluth-parks-and-recreation',
      AUTHORITY,
    ])
      expect(got).toContain(id);
    expect(got).not.toContain('duluth-cross-country-ski-club');
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

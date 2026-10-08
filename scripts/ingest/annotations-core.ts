import { z } from 'zod';
import type { Area, AreaKind } from '../../src/schema/area';
import { AreaFeatureCollectionSchema } from '../../src/schema/area';
import type { Annotation } from '../../src/schema/annotation';
import type { AnnotationsFile } from '../../src/schema/annotations-file';
import { annotationsFileForAreas } from '../../src/schema/annotations-file';
import type { Organization } from '../../src/schema/organization';
import { OrganizationSchema } from '../../src/schema/organization';
import { sha256Hex } from './replay';

/** A named, exit-coded failure of the annotations transform. `code` is the error name printed on stderr. */
export class AnnotationsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

/** What the seed rule reads of an area: id and kind, plus the OSM name for the lift rules. */
export type AreaRef = Pick<Area, 'id' | 'kind'> & { readonly name?: string | null };

export const DERIVED_NOTE = 'derived from OSM kind';

type ActivityEntry = Annotation['activities'][number];
/** An original source for one rule: where the claim comes from and what the page says. Written into the annotation notes. */
export type RuleSource = { readonly url: string; readonly note: string };

type KindRule = readonly {
  readonly activity: ActivityEntry['activity'];
  readonly seasons: ActivityEntry['seasons'];
  /** Absent only for the structural defaults noted DERIVED_NOTE. Every added activity cites a source. */
  readonly source?: RuleSource;
}[];

const WARM: ActivityEntry['seasons'] = ['spring', 'summer', 'fall'];

const TUBING_SOURCE: RuleSource = {
  url: 'https://spiritmt.com/winter/tubing/',
  note: 'Tubing Hill served by a tubing lift; season ends mid March',
};
const SNOWSHOE_SOURCE: RuleSource = {
  url: 'https://spiritmt.com/winter/nordic/',
  note: 'rental snowshoes at the Upper Nordic Building on weekends; trails not specified on the page',
};
const FAT_BIKE_SOURCE: RuleSource = {
  url: 'https://spiritmt.com/winter/downhill/',
  note: 'fat bikes acknowledged with a rider-responsibility statement; trails not specified on the page',
};
const ADAPTIVE_SOURCE: RuleSource = {
  url: 'https://spiritmt.com/?p=34',
  note: 'lessons page lists Northland Adaptive',
};
const MTB_HUMAN_POWERED_SOURCE: RuleSource = {
  url: 'https://coggs.com/',
  note: 'all COGGS trails open to human-powered, non-motorized use',
};
const SUMMER_LIFT_SOURCE: RuleSource = {
  url: 'https://spiritmt.com/summer/adventure-park/',
  note: 'scenic chairlift; months not stated',
};

/** The text written into an annotation's notes: the structural default, or the source note followed by its URL. */
export function noteFor(source: RuleSource | undefined): string {
  return source === undefined ? DERIVED_NOTE : `${source.note} (${source.url})`;
}

/**
 * Decision record: these season defaults are structural (a downhill run is a winter facility by definition), not world facts.
 * Nothing is read from OSM tags beyond the kind and the name. An entry with no note says "derived from OSM kind"; an entry that adds an activity OSM does not state carries a source (url and note) written into its notes (docs/activity-audit.md).
 * Typed as Record<AreaKind, ...> so the compiler fails when the area schema gains a kind.
 */
const KIND_RULES: Record<AreaKind, KindRule> = {
  'downhill-run': [
    { activity: 'alpine-ski', seasons: ['winter', 'spring'] },
    { activity: 'snowboard', seasons: ['winter', 'spring'] },
    { activity: 'adaptive', seasons: ['winter', 'spring'], source: ADAPTIVE_SOURCE },
  ],
  'snow-park': [
    { activity: 'alpine-ski', seasons: ['winter', 'spring'] },
    { activity: 'snowboard', seasons: ['winter', 'spring'] },
    { activity: 'adaptive', seasons: ['winter', 'spring'], source: ADAPTIVE_SOURCE },
  ],
  'nordic-trail': [
    { activity: 'nordic-classic', seasons: ['winter'] },
    { activity: 'nordic-skate', seasons: ['winter'] },
    { activity: 'snowshoe', seasons: ['winter'], source: SNOWSHOE_SOURCE },
  ],
  'mtb-trail': [
    { activity: 'mountain-bike', seasons: WARM },
    { activity: 'hike', seasons: WARM, source: MTB_HUMAN_POWERED_SOURCE },
    { activity: 'trail-run', seasons: WARM, source: MTB_HUMAN_POWERED_SOURCE },
    { activity: 'fat-bike', seasons: ['winter'], source: FAT_BIKE_SOURCE },
  ],
  'mtb-route': [
    { activity: 'mountain-bike', seasons: WARM },
    { activity: 'hike', seasons: WARM, source: MTB_HUMAN_POWERED_SOURCE },
    { activity: 'trail-run', seasons: WARM, source: MTB_HUMAN_POWERED_SOURCE },
    { activity: 'fat-bike', seasons: ['winter'], source: FAT_BIKE_SOURCE },
  ],
  lift: [{ activity: 'lift-ride', seasons: ['winter'] }],
  'hiking-trail': [
    { activity: 'hike', seasons: WARM },
    { activity: 'trail-run', seasons: WARM },
  ],
  'tubing-run': [{ activity: 'tubing', seasons: ['winter'], source: TUBING_SOURCE }],
};

/**
 * Lift rules that depend on the OSM name, applied on top of KIND_RULES.lift: Spirit Express II also runs in summer,
 * and a tubing tow carries the tubing activity.
 */
function liftRule(name: string | null | undefined): KindRule {
  const base: KindRule = [{ activity: 'lift-ride', seasons: ['winter'] }];
  if (name === null || name === undefined) return base;
  if (/tubing/i.test(name))
    return [...base, { activity: 'tubing', seasons: ['winter'], source: TUBING_SOURCE }];
  if (/^spirit express ii$/i.test(name))
    return [{ activity: 'lift-ride', seasons: ['winter', 'summer'], source: SUMMER_LIFT_SOURCE }];
  return base;
}

/** Code-unit string order. Never a locale-sensitive comparison: it must give the same answer on every machine. */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const AUTHORITY_ORG_ID = 'spirit-mountain-recreation-area-authority';

type StakeholderLink = Annotation['stakeholders'][number];

/**
 * Decision record: the role follows the organization's type, because the seed holds no per-area fact about what an organization does there.
 * The Authority operates the hill; public bodies maintain; clubs run programs; nonprofits advocate; businesses fund.
 */
const ROLE_BY_ORG_TYPE: Record<Organization['type'], StakeholderLink['role']> = {
  authority: 'operates',
  municipal: 'maintains',
  'state-agency': 'maintains',
  club: 'programs',
  nonprofit: 'advocates',
  business: 'funds',
};

/**
 * @displayName Stakeholder rule
 * @strategicPurpose Attaches related organizations to each area without hand-editing, so the stakeholder panel shows who is connected to what.
 * @tacticalObjective Pure function: every verified organization (an unverified one is never assigned) whose activities intersect the area's activities, plus the Recreation Authority on every area (a lift gets only the Authority), one link per org, role by org type, sorted by org id in code-unit order.
 */
export function stakeholdersFor(
  activities: readonly ActivityEntry[],
  organizations: readonly Organization[],
): StakeholderLink[] {
  const present = new Set(activities.map((entry) => entry.activity));
  return organizations
    .filter((org) => org.verified)
    .filter((org) => org.id === AUTHORITY_ORG_ID || org.activities.some((a) => present.has(a)))
    .sort((a, b) => compareCodeUnit(a.id, b.id))
    .map((org) => ({ orgId: org.id, role: ROLE_BY_ORG_TYPE[org.type] }));
}

/** The canonical serialization of every output file: 2-space JSON, LF, one trailing newline. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function decodeJson(bytes: Uint8Array, label: string, code: string): unknown {
  try {
    // ignoreBOM keeps a byte-order mark in the text so JSON.parse rejects it, instead of silently stripping it.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (cause) {
    throw new AnnotationsError(
      code,
      `${label} is not valid UTF-8 JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * @displayName Areas boundary parse
 * @strategicPurpose Parses the foreign file data/areas.geojson where it enters, so a renamed field or an empty file is an error and never an empty annotations list.
 * @tacticalObjective Decodes the bytes once, rejects zero features as NoAreas, parses the rest with AreaFeatureCollectionSchema, and returns each feature's id, kind and name (all this transform reads).
 */
export function parseAreas(bytes: Uint8Array): AreaRef[] {
  const raw = decodeJson(bytes, 'areas file', 'AreasNotJson');
  const features = (raw as { features?: unknown } | null)?.features;
  if (Array.isArray(features) && features.length === 0) {
    throw new AnnotationsError(
      'NoAreas',
      'areas file has zero features; an empty areas list is an error, not an empty annotations file',
    );
  }
  const result = AreaFeatureCollectionSchema.safeParse(raw);
  if (!result.success)
    throw new AnnotationsError('AreasInvalid', formatIssues(result.error.issues));
  return result.data.features.map(({ properties }) => ({
    id: properties.id,
    kind: properties.kind,
    name: properties.name,
  }));
}

// A plain array wrapper around #6's OrganizationSchema; the min(1) makes an empty seed an error.
const OrganizationListSchema = z.array(OrganizationSchema).min(1);

/**
 * @displayName Organizations seed boundary parse
 * @strategicPurpose Parses the foreign file scripts/ingest/organizations.seed.json where it enters, so a renamed key or a missing field fails loudly instead of being stripped or defaulted.
 * @tacticalObjective Decodes the bytes once, rejects an empty array as NoOrganizations, parses with z.array(OrganizationSchema), and names the row index, id and field of every failure.
 */
export function parseSeed(bytes: Uint8Array): Organization[] {
  const raw = decodeJson(bytes, 'organizations seed', 'SeedNotJson');
  if (Array.isArray(raw) && raw.length === 0) {
    throw new AnnotationsError(
      'NoOrganizations',
      'organizations seed has zero rows; an empty seed is an error',
    );
  }
  const result = OrganizationListSchema.safeParse(raw);
  if (!result.success) {
    const rows = Array.isArray(raw) ? (raw as unknown[]) : [];
    const detail = result.error.issues.map((issue) => {
      const index = typeof issue.path[0] === 'number' ? issue.path[0] : -1;
      const id = (rows[index] as { id?: unknown } | undefined)?.id;
      const where = index >= 0 ? `row ${index} (${typeof id === 'string' ? id : 'no id'}) ` : '';
      return `${where}${
        issue.path
          .slice(index >= 0 ? 1 : 0)
          .map(String)
          .join('.') || '(row)'
      }: ${issue.message}`;
    });
    throw new AnnotationsError('SeedInvalid', detail.join('; '));
  }
  return result.data;
}

type BuiltAnnotations = { organizations: Organization[]; annotations: Annotation[] };

/**
 * @displayName Seed annotations builder
 * @strategicPurpose Gives every area a schema-valid annotation from day one without inventing any world fact, and carries every seed organization through unchanged.
 * @tacticalObjective Pure function: one annotation per area with kind-derived activities (each noted "derived from OSM kind"), rule-derived stakeholders and empty notes, sorted by areaId; organizations copied field by field in seed order of keys, sorted by id. Declared effect is expands.
 */
export function buildAnnotations(
  areas: readonly AreaRef[],
  organizations: readonly Organization[],
): BuiltAnnotations {
  const areaIds = new Set<string>();
  for (const area of areas) {
    if (areaIds.has(area.id))
      throw new AnnotationsError('DuplicateAreaId', `duplicate area id ${area.id}`);
    areaIds.add(area.id);
  }
  const orgIds = new Set<string>();
  for (const org of organizations) {
    if (orgIds.has(org.id))
      throw new AnnotationsError('DuplicateOrgId', `duplicate organization id ${org.id}`);
    orgIds.add(org.id);
  }
  const annotations: Annotation[] = [...areas]
    .sort((a, b) => compareCodeUnit(a.id, b.id))
    .map((area) => {
      const kindRule = (KIND_RULES as Partial<Record<string, KindRule>>)[area.kind];
      const rule = area.kind === 'lift' ? liftRule(area.name) : kindRule;
      if (rule === undefined)
        throw new AnnotationsError('UnmappedKind', `no activity rule for kind ${area.kind}`);
      const activities = rule.map((entry) => ({
        activity: entry.activity,
        seasons: [...entry.seasons],
        notes: noteFor(entry.source),
      }));
      return {
        areaId: area.id,
        activities,
        stakeholders: stakeholdersFor(activities, organizations),
        notes: '',
      };
    });
  const carried: Organization[] = [...organizations]
    .sort((a, b) => compareCodeUnit(a.id, b.id))
    .map((org) => ({
      id: org.id,
      name: org.name,
      url: org.url,
      type: org.type,
      activities: [...org.activities],
      sourceUrl: org.sourceUrl,
      verified: org.verified,
    }));
  // Declared effect "expands": one annotation per area, and more items out than areas in.
  if (annotations.length !== areas.length || annotations.length + carried.length <= areas.length) {
    throw new AnnotationsError(
      'EffectViolated',
      `effect expands violated: ${areas.length} areas in, ${annotations.length} annotations and ${carried.length} organizations out`,
    );
  }
  return { organizations: carried, annotations };
}

/**
 * @displayName Emitter-side reference check
 * @strategicPurpose Closes the cross-file seam on the emitting side: no annotation may point at a missing area or organization, and no area may lack an annotation.
 * @tacticalObjective Runs annotationsFileForAreas (schema plus unique ids, resolvable orgIds, known areaIds) and then requires every area id to have an annotation; throws AnnotationsInvalid or MissingAnnotation.
 */
export function checkEmittedFile(file: AnnotationsFile, areaIds: ReadonlySet<string>): void {
  const result = annotationsFileForAreas(areaIds).safeParse(file);
  if (!result.success)
    throw new AnnotationsError('AnnotationsInvalid', formatIssues(result.error.issues));
  const annotated = new Set(file.annotations.map((annotation) => annotation.areaId));
  for (const id of areaIds) {
    if (!annotated.has(id))
      throw new AnnotationsError('MissingAnnotation', `area ${id} has no annotation`);
  }
}

/**
 * @displayName Seed annotations generator
 * @strategicPurpose The whole deterministic transform from two pinned input byte arrays to the two output texts; no clock, network, filesystem or git.
 * @tacticalObjective Parses both inputs, builds and gates the annotations file, and returns data/annotations.json text plus the data/annotations.replay.json text whose outputHash is the sha256 of the first.
 */
export function generateAnnotations(input: {
  areasBytes: Uint8Array;
  seedBytes: Uint8Array;
  codeCommit: string;
}): {
  fileText: string;
  replayText: string;
  file: AnnotationsFile;
  counts: { areas: number; organizations: number };
} {
  const areas = parseAreas(input.areasBytes);
  const seed = parseSeed(input.seedBytes);
  const { organizations, annotations } = buildAnnotations(areas, seed);
  const inputHash = sha256Hex(
    `data/areas.geojson:${sha256Hex(input.areasBytes)}\nscripts/ingest/organizations.seed.json:${sha256Hex(input.seedBytes)}\n`,
  );
  const file: AnnotationsFile = {
    version: 1,
    // A file cannot hold its own hash: generatedFrom has no outputHash; the sidecar carries it.
    generatedFrom: { inputHash, codeCommit: input.codeCommit, effect: 'expands' },
    organizations,
    annotations,
  };
  checkEmittedFile(file, new Set(areas.map((area) => area.id)));
  const fileText = serialize(file);
  const replayText = serialize({
    inputHash,
    codeCommit: input.codeCommit,
    outputHash: sha256Hex(fileText),
    effect: 'expands',
  });
  return {
    fileText,
    replayText,
    file,
    counts: { areas: areas.length, organizations: organizations.length },
  };
}

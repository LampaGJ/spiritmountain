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

export const DERIVED_NOTE = 'derived from OSM kind';

type ActivityEntry = Annotation['activities'][number];
type KindRule = readonly {
  readonly activity: ActivityEntry['activity'];
  readonly seasons: ActivityEntry['seasons'];
}[];

/**
 * Decision record: these season defaults are structural (a downhill run is a winter facility by definition), not world facts.
 * Nothing is inferred from OSM tags, and every derived entry carries the note "derived from OSM kind" so a human can tell a default from a confirmed fact.
 * Typed as Record<AreaKind, ...> so the compiler fails when the area schema gains a kind.
 */
const KIND_RULES: Record<AreaKind, KindRule> = {
  'downhill-run': [
    { activity: 'alpine-ski', seasons: ['winter'] },
    { activity: 'snowboard', seasons: ['winter'] },
  ],
  'snow-park': [
    { activity: 'alpine-ski', seasons: ['winter'] },
    { activity: 'snowboard', seasons: ['winter'] },
  ],
  'nordic-trail': [
    { activity: 'nordic-classic', seasons: ['winter'] },
    { activity: 'nordic-skate', seasons: ['winter'] },
  ],
  'mtb-trail': [{ activity: 'mountain-bike', seasons: ['summer', 'fall'] }],
  'mtb-route': [{ activity: 'mountain-bike', seasons: ['summer', 'fall'] }],
  lift: [{ activity: 'lift-ride', seasons: [] }],
};

/** Code-unit string order. Never a locale-sensitive comparison: it must give the same answer on every machine. */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
 * @tacticalObjective Decodes the bytes once, rejects zero features as NoAreas, parses the rest with AreaFeatureCollectionSchema, and returns each feature's properties (id and kind are all this transform reads).
 */
export function parseAreas(bytes: Uint8Array): Pick<Area, 'id' | 'kind'>[] {
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
  return result.data.features.map((feature) => feature.properties);
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
 * @tacticalObjective Pure function: one annotation per area with kind-derived activities (each noted "derived from OSM kind"), empty stakeholders and notes, sorted by areaId; organizations copied field by field in seed order of keys, sorted by id. Declared effect is expands.
 */
export function buildAnnotations(
  areas: readonly Pick<Area, 'id' | 'kind'>[],
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
      const rule = (KIND_RULES as Partial<Record<string, KindRule>>)[area.kind];
      if (rule === undefined)
        throw new AnnotationsError('UnmappedKind', `no activity rule for kind ${area.kind}`);
      return {
        areaId: area.id,
        activities: rule.map((entry) => ({
          activity: entry.activity,
          seasons: [...entry.seasons],
          notes: DERIVED_NOTE,
        })),
        stakeholders: [],
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

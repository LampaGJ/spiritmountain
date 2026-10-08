import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { annotationsFileForAreas } from '../../src/schema/annotations-file';
import { AreaKindSchema, type AreaKind } from '../../src/schema/area';

/**
 * @displayName Annotations fixture generator
 * @strategicPurpose Produces tests/fixtures/annotations.json deterministically so the fixture is never hand-edited (user CLAUDE.md:30).
 * @tacticalObjective Reads ids and kinds from tests/fixtures/areas.geojson, annotates every area except the snow-park, and validates the output with #6's annotationsFileForAreas (the emitter gate) before writing.
 */
export interface FixtureArea {
  readonly id: string;
  readonly kind: AreaKind;
}

/** Fixture-only activity per kind. Seasons stay [] (blank) because seasons are facts we do not invent. */
const ACTIVITY_BY_KIND = {
  'downhill-run': 'alpine-ski',
  'nordic-trail': 'nordic-classic',
  'mtb-trail': 'mountain-bike',
  lift: 'lift-ride',
  'snow-park': null,
  'mtb-route': 'mountain-bike',
  'hiking-trail': 'hike',
  'tubing-run': 'tubing',
} as const satisfies Record<AreaKind, string | null>;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** Pure core: areas in, fixture JSON text out. snow-park areas get no entry, to exercise the "no annotation" state. */
export function buildAnnotationsFixture(
  areas: readonly FixtureArea[],
  inputSha256: string,
): string {
  const sorted = [...areas].sort((a, b) => compare(a.id, b.id));
  const organizations = [
    {
      id: 'fixture-org-a',
      name: 'Fixture Org A',
      url: null,
      type: 'club',
      activities: [],
      sourceUrl: '',
      verified: false,
    },
    {
      id: 'fixture-org-b',
      name: 'Fixture Org B',
      url: null,
      type: 'municipal',
      activities: [],
      sourceUrl: '',
      verified: false,
    },
  ];
  const annotations = sorted.flatMap((area, index) => {
    const activity = ACTIVITY_BY_KIND[area.kind];
    if (activity === null) return [];
    return [
      {
        areaId: area.id,
        activities: [{ activity, seasons: [], notes: '' }],
        // Synthetic fixture value: exactly one annotated area (the first by id) carries a stakeholder.
        stakeholders: index === 0 ? [{ orgId: 'fixture-org-a', role: 'maintains' }] : [],
        notes: '',
      },
    ];
  });
  const file = {
    version: 1,
    generatedFrom: {
      inputHash: inputSha256,
      codeCommit: '0'.repeat(40), // sentinel: a fixture has no real commit
      effect: 'expands', // no outputHash: #6's GeneratedFromSchema omits it
    },
    organizations,
    annotations,
  };
  annotationsFileForAreas(new Set(sorted.map((area) => area.id))).parse(file); // emitter gate: throws before anything is written
  return `${JSON.stringify(file, null, 2)}\n`;
}

const AreasFixtureSchema = z.object({
  features: z
    .array(z.object({ properties: z.object({ id: z.string(), kind: AreaKindSchema }) }))
    .min(1),
});

/** Reads ids and kinds from the #12 fixture (feature shape defined by #8: properties.id, properties.kind). */
export function readAreasFixture(path: string): { areas: FixtureArea[]; inputSha256: string } {
  const bytes = readFileSync(path);
  const parsed = AreasFixtureSchema.parse(JSON.parse(bytes.toString('utf8')));
  return {
    areas: parsed.features.map((feature) => ({
      id: feature.properties.id,
      kind: feature.properties.kind,
    })),
    inputSha256: sha256(bytes),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { areas, inputSha256 } = readAreasFixture('tests/fixtures/areas.geojson');
  writeFileSync('tests/fixtures/annotations.json', buildAnnotationsFixture(areas, inputSha256));
  console.log(`wrote tests/fixtures/annotations.json (${areas.length} areas)`);
}

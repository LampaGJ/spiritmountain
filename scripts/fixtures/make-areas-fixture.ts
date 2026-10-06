/**
 * @displayName Areas fixture generator
 * @strategicPurpose Produces tests/fixtures/areas.geojson so #12 develops and tests before #8 lands,
 *   without any hand-edited data. Replay: run it twice; git diff must be empty.
 * @tacticalObjective Emit nine areas in local metres (one per kind plus all four lift types, one
 *   Polygon, one 3-vertex lift, one vertex east of the fixture field), validated by
 *   AreaFeatureCollectionSchema (from src/schema/area.ts) before the file is written (emitter gate).
 *
 * The fixture field (tests/fixtures/make-field.ts) spans east -315..315 and north -282..282.
 * Every vertex lies inside it except way/1001's last vertex (east 330), which exercises the clamp.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AreaFeatureCollectionSchema, type AreaKind } from '../../src/schema/area';

type Pos = [number, number, number];

function lineFeature(
  id: string,
  kind: AreaKind,
  name: string | null,
  difficulty: string | null,
  osmTags: Record<string, string>,
  points: Array<[number, number]>,
) {
  return {
    type: 'Feature' as const,
    properties: { id, kind, name, difficulty, osmTags },
    geometry: { type: 'LineString' as const, coordinates: points.map(([e, n]): Pos => [e, n, 0]) },
  };
}

const ring: Array<[number, number]> = [
  [150, 120],
  [230, 120],
  [230, 200],
  [150, 200],
  [150, 120],
];

const collection = {
  type: 'FeatureCollection' as const,
  features: [
    lineFeature(
      'way/1001',
      'downhill-run',
      'Fixture Run',
      'intermediate',
      { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate' },
      [
        [-250, 200],
        [-120, 120],
        [-20, 40],
        [60, -20],
        [140, -90],
        [220, -170],
        [330, -250],
      ],
    ),
    lineFeature('way/1002', 'nordic-trail', null, null, { 'piste:type': 'nordic' }, [
      [-280, -200],
      [-200, -150],
      [-100, -190],
      [0, -230],
      [100, -200],
    ]),
    lineFeature('way/1003', 'mtb-trail', null, '1', { 'mtb:scale': '1' }, [
      [-300, 100],
      [-220, 60],
      [-150, 100],
      [-80, 40],
    ]),
    {
      type: 'Feature' as const,
      properties: {
        id: 'way/1004',
        kind: 'snow-park' as const,
        name: null,
        difficulty: null,
        osmTags: { 'piste:type': 'snow_park' },
      },
      geometry: { type: 'Polygon' as const, coordinates: [ring.map(([e, n]): Pos => [e, n, 0])] },
    },
    lineFeature('way/1005', 'mtb-route', null, null, { route: 'mtb' }, [
      [-60, 250],
      [40, 200],
      [140, 240],
    ]),
    lineFeature('way/1006', 'lift', null, null, { aerialway: 'chair_lift' }, [
      [-120, -20],
      [-30, -20],
      [60, -20],
    ]),
    lineFeature('way/1007', 'lift', null, null, { aerialway: 'drag_lift' }, [
      [200, -60],
      [260, -110],
    ]),
    lineFeature('way/1008', 'lift', null, null, { aerialway: 'rope_tow' }, [
      [-200, 230],
      [-150, 200],
    ]),
    lineFeature('way/1009', 'lift', null, null, { aerialway: 'magic_carpet' }, [
      [100, -250],
      [120, -230],
    ]),
  ],
};

const checked = AreaFeatureCollectionSchema.safeParse(collection);
if (!checked.success) {
  throw new Error(`fixture failed its own schema: ${checked.error.message}`);
}

const outPath = fileURLToPath(new URL('../../tests/fixtures/areas.geojson', import.meta.url));
const body = checked.data.features.map((f) => `  ${JSON.stringify(f)}`).join(',\n');
writeFileSync(outPath, `{"type":"FeatureCollection","features":[\n${body}\n]}\n`);
console.log(`wrote ${checked.data.features.length} features to ${outPath}`);

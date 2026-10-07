import type { BuildingFeatureCollection } from '../../src/schema/building';
import type { BuildingsReplay } from './buildings-replay-schema';
import { obj, round2, writeJson, type JsonNode } from './areas-serialize';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @displayName Buildings file serializer
 * @strategicPurpose Fixes the on-disk shape of data/buildings.geojson (key order, sorted osmTags) so the same data always yields the same bytes.
 * @tacticalObjective Converts a validated BuildingFeatureCollection into the ordered JSON text through the shared stable writer, rounding every coordinate and heightM to 2 decimals.
 */
export function serializeBuildings(collection: BuildingFeatureCollection): string {
  const features = collection.features.map((feature) =>
    obj([
      ['type', 'Feature'],
      [
        'properties',
        obj([
          ['id', feature.properties.id],
          ['kind', feature.properties.kind],
          ['name', feature.properties.name],
          ['heightM', round2(feature.properties.heightM)],
          ['levels', feature.properties.levels],
          ['source', feature.properties.source],
          [
            'osmTags',
            obj(
              Object.entries(feature.properties.osmTags)
                .sort(([a], [b]) => byCodeUnit(a, b))
                .map(([key, value]) => [key, value] as const),
            ),
          ],
        ]),
      ],
      [
        'geometry',
        obj([
          ['type', feature.geometry.type],
          [
            'coordinates',
            feature.geometry.coordinates.map((ring) => ring.map((p) => p.map(round2))),
          ],
        ]),
      ],
    ]),
  );
  return writeJson(
    obj([
      ['type', 'FeatureCollection'],
      ['features', features],
    ]),
  );
}

function toNode(value: unknown): JsonNode {
  if (Array.isArray(value)) return value.map(toNode);
  if (typeof value === 'object' && value !== null) {
    return obj(Object.entries(value).map(([key, item]) => [key, toNode(item)] as const));
  }
  return value as JsonNode;
}

/**
 * @displayName Buildings replay serializer
 * @strategicPurpose Fixes the on-disk shape of data/buildings.replay.json so its bytes are stable too.
 * @tacticalObjective Writes the validated BuildingsReplay in schema key order with the same layout as the buildings file.
 */
export function serializeBuildingsReplay(replay: BuildingsReplay): string {
  return writeJson(toNode(replay));
}

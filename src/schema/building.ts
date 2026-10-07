import { z } from 'zod';
import { PolygonGeometrySchema } from './area';

/**
 * @displayName Building id
 * @strategicPurpose One id pattern for building footprints, so a malformed key fails at parse instead of at lookup.
 * @tacticalObjective Validates an OSM way or relation id, with an optional "#n" suffix that numbers one outer ring of an exploded multipolygon (way/N, relation/N, relation/N#2).
 */
export const BuildingIdSchema = z.string().regex(/^(way|relation)\/\d+(#\d+)?$/, {
  error: 'id must be "way/<n>", "relation/<n>" or "relation/<n>#<k>"',
});

/**
 * @displayName Building height source
 * @strategicPurpose Says where a footprint's extrusion height came from, so a guessed height is never mistaken for a surveyed one.
 * @tacticalObjective Closed enum: the OSM height tag, building:levels times 3 m, or the type table fallback.
 */
export const BuildingHeightSourceSchema = z.enum(['height', 'levels', 'type-table']);
export type BuildingHeightSource = z.infer<typeof BuildingHeightSourceSchema>;

/**
 * @displayName Building properties
 * @strategicPurpose The non-geometry half of a building; it is exactly the `properties` member of a feature in data/buildings.geojson.
 * @tacticalObjective Validates id, kind, name, heightM, levels, height source and raw OSM tags.
 */
export const BuildingPropertiesSchema = z.strictObject({
  /** OSM type and id, for example "way/123"; "#k" marks one outer ring of a multipolygon relation. */
  id: BuildingIdSchema,
  /** The raw OSM building value (for example "detached"), or the man_made value (for example "tower") when there is no building tag. */
  kind: z.string().min(1),
  name: z.string().nullable(),
  /** Extrusion height in metres. */
  heightM: z.number().positive(),
  /** building:levels as an integer, or null when absent or unusable. */
  levels: z.number().int().positive().nullable(),
  source: BuildingHeightSourceSchema,
  osmTags: z.record(z.string(), z.string()),
});

/**
 * @displayName Building
 * @strategicPurpose The flat canonical record of one building footprint (properties plus geometry) the scene extrudes on the terrain.
 * @tacticalObjective Validates id, kind, name, heightM, levels, height source, raw OSM tags and a closed-ring Polygon in local metres.
 */
export const BuildingSchema = BuildingPropertiesSchema.extend({
  geometry: PolygonGeometrySchema,
});
export type Building = z.infer<typeof BuildingSchema>;

/**
 * @displayName Building feature
 * @strategicPurpose The on-disk GeoJSON form of one Building; consumers recombine properties and geometry into a Building.
 * @tacticalObjective Validates a Feature whose id lives in properties.id (a top-level Feature id member is rejected).
 */
export const BuildingFeatureSchema = z.strictObject({
  type: z.literal('Feature'),
  properties: BuildingPropertiesSchema,
  geometry: PolygonGeometrySchema,
});
export type BuildingFeature = z.infer<typeof BuildingFeatureSchema>;

/**
 * @displayName Buildings file
 * @strategicPurpose The boundary parse for the whole data/buildings.geojson envelope; an empty or malformed file is an error, never an empty list.
 * @tacticalObjective Validates a FeatureCollection of at least one BuildingFeature with unique properties.id values.
 */
export const BuildingFeatureCollectionSchema = z
  .strictObject({
    type: z.literal('FeatureCollection'),
    features: z.array(BuildingFeatureSchema).min(1),
  })
  .superRefine((collection, ctx) => {
    const seen = new Set<string>();
    collection.features.forEach((feature, index) => {
      const id = feature.properties.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['features', index, 'properties', 'id'],
          message: `duplicate building id ${id}`,
        });
      }
      seen.add(id);
    });
  });
export type BuildingFeatureCollection = z.infer<typeof BuildingFeatureCollectionSchema>;

import { z } from 'zod';

/**
 * @displayName Area id
 * @strategicPurpose One id pattern shared by areas and by annotation keys, so a malformed key fails at parse instead of at lookup.
 * @tacticalObjective Validates an OSM element id of the form node/N, way/N or relation/N.
 */
export const AreaIdSchema = z
  .string()
  .regex(/^(node|way|relation)\/\d+$/, { error: 'id must be "<osm type>/<number>"' });

/**
 * @displayName Area kind
 * @strategicPurpose Names the recreational categories the scene colours and filters by.
 * @tacticalObjective Closed enum of the six kinds the OSM transform may emit.
 */
export const AreaKindSchema = z.enum([
  'downhill-run',
  'nordic-trail',
  'mtb-trail',
  'lift',
  'snow-park',
  'mtb-route',
]);
export type AreaKind = z.infer<typeof AreaKindSchema>;

/** A local-metre position: [east, north, elevation]. */
const PositionSchema = z.tuple([z.number(), z.number(), z.number()]);

/**
 * @displayName Line geometry
 * @strategicPurpose Carries runs, trails and lifts in local metres.
 * @tacticalObjective Validates a LineString of at least two positions with z as elevation.
 */
export const LineStringGeometrySchema = z.strictObject({
  type: z.literal('LineString'),
  coordinates: z.array(PositionSchema).min(2),
});

/**
 * @displayName Polygon geometry
 * @strategicPurpose Carries zone-like areas such as snow parks in local metres.
 * @tacticalObjective Validates polygon rings of at least four positions each, closed (first equals last), z as elevation.
 */
export const PolygonGeometrySchema = z
  .strictObject({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(PositionSchema).min(4)).min(1),
  })
  .superRefine((polygon, ctx) => {
    polygon.coordinates.forEach((ring, ringIndex) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      const closed =
        first !== undefined && last !== undefined && first.every((value, i) => value === last[i]);
      if (!closed) {
        ctx.addIssue({
          code: 'custom',
          path: ['coordinates', ringIndex],
          message: 'polygon ring must be closed (first position equals last)',
        });
      }
    });
  });

/**
 * @displayName Area geometry
 * @strategicPurpose One geometry contract for every area, discriminated by GeoJSON type.
 * @tacticalObjective Selects the LineString or Polygon schema from the `type` key.
 */
export const AreaGeometrySchema = z.discriminatedUnion('type', [
  LineStringGeometrySchema,
  PolygonGeometrySchema,
]);

/**
 * @displayName Area properties
 * @strategicPurpose The non-geometry half of an area; it is exactly the `properties` member of a feature in data/areas.geojson.
 * @tacticalObjective Validates id, kind, name, difficulty and raw OSM tags.
 */
export const AreaPropertiesSchema = z.strictObject({
  /** OSM type and id, for example "way/123". */
  id: AreaIdSchema,
  kind: AreaKindSchema,
  name: z.string().nullable(),
  /** Verbatim OSM piste:difficulty or mtb:scale; null when OSM has neither. */
  difficulty: z.string().nullable(),
  osmTags: z.record(z.string(), z.string()),
});

/**
 * @displayName Area
 * @strategicPurpose The flat canonical record of one recreational area (properties plus geometry), shared by transform, seed generator, scene and editor.
 * @tacticalObjective Validates id, kind, name, difficulty, local-metre geometry and raw OSM tags.
 */
export const AreaSchema = AreaPropertiesSchema.extend({
  geometry: AreaGeometrySchema,
});
export type Area = z.infer<typeof AreaSchema>;

/**
 * @displayName Area feature
 * @strategicPurpose The on-disk GeoJSON form of one Area; consumers recombine properties and geometry into an Area.
 * @tacticalObjective Validates a Feature whose id lives in properties.id (a top-level Feature id member is rejected).
 */
export const AreaFeatureSchema = z.strictObject({
  type: z.literal('Feature'),
  properties: AreaPropertiesSchema,
  geometry: AreaGeometrySchema,
});
export type AreaFeature = z.infer<typeof AreaFeatureSchema>;

/**
 * @displayName Areas file
 * @strategicPurpose The boundary parse for the whole data/areas.geojson envelope; an empty or malformed file is an error, never an empty list.
 * @tacticalObjective Validates a FeatureCollection of at least one AreaFeature with unique properties.id values.
 */
export const AreaFeatureCollectionSchema = z
  .strictObject({
    type: z.literal('FeatureCollection'),
    features: z.array(AreaFeatureSchema).min(1),
  })
  .superRefine((collection, ctx) => {
    const seen = new Set<string>();
    collection.features.forEach((feature, index) => {
      const id = feature.properties.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['features', index, 'properties', 'id'],
          message: `duplicate area id ${id}`,
        });
      }
      seen.add(id);
    });
  });
export type AreaFeatureCollection = z.infer<typeof AreaFeatureCollectionSchema>;

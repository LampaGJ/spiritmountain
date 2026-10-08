import { z } from 'zod';
import { GeneratedFromSchema } from './replay';

/** An http or https url only; javascript: and file: are rejected. */
const HttpUrlSchema = z.url({ protocol: /^https?$/ });
const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters (sha256)' });
const PlaceIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: 'id must be lowercase kebab-case' });

/**
 * @displayName Place kind
 * @strategicPurpose Classifies a named place so a later label rule can prefer one kind over another without parsing names.
 * @tacticalObjective Closed enum of the eight kinds in the place-names seed.
 */
export const PlaceKindSchema = z.enum([
  'chalet',
  'peak',
  'overlook',
  'park-zone',
  'nordic-centre',
  'campground',
  'adventure-park',
  'lift-top',
]);
export type PlaceKind = z.infer<typeof PlaceKindSchema>;

/**
 * @displayName Place anchor
 * @strategicPurpose Gives a place with no surveyed coordinate a defensible position rule, resolved by the transform from data already in the repo, never typed by hand.
 * @tacticalObjective Validates one of two rules: a named area in data/areas.geojson with a position on it (top and bottom are the last and first vertex of a line, in OSM way direction; centroid is the mean of every vertex of every area of that name), or the id of another seed place that has its own lat and lon.
 */
export const PlaceAnchorSchema = z.union([
  z.strictObject({
    areaName: z.string().min(1),
    at: z.enum(['top', 'bottom', 'centroid']),
  }),
  z.strictObject({ placeId: PlaceIdSchema }),
]);
export type PlaceAnchor = z.infer<typeof PlaceAnchorSchema>;

/**
 * @displayName Place seed row
 * @strategicPurpose The primary-source input of the places transform: one named place with where its name came from and how its position is known. Hand-edited by design, like organizations.seed.json.
 * @tacticalObjective Validates id, name, kind, lat and lon (both set or both null), radiusM, an anchor or null, sourceUrl, verified and positionNote. A row may carry coordinates or an anchor but not both, and verified: true needs one of them.
 */
export const PlaceSeedSchema = z
  .strictObject({
    id: PlaceIdSchema,
    name: z.string().min(1),
    kind: PlaceKindSchema,
    lat: z.number().min(-90).max(90).nullable(),
    lon: z.number().min(-180).max(180).nullable(),
    // How far the name reaches from its point, in metres: 200 for a chalet, 400 for a bike-park zone, 600 for a peak.
    radiusM: z.number().positive().max(5000),
    anchor: PlaceAnchorSchema.nullable(),
    sourceUrl: HttpUrlSchema,
    verified: z.boolean(),
    positionNote: z.string().min(1),
  })
  .superRefine((row, ctx) => {
    if ((row.lat === null) !== (row.lon === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lat'],
        message: 'lat and lon must both be set or both null',
      });
    }
    const hasCoordinates = row.lat !== null && row.lon !== null;
    if (hasCoordinates && row.anchor !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['anchor'],
        message: 'a row carries coordinates or an anchor, not both',
      });
    }
    if (row.verified && !hasCoordinates && row.anchor === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['verified'],
        message: 'verified: true needs coordinates or an anchor',
      });
    }
  });
export type PlaceSeed = z.infer<typeof PlaceSeedSchema>;

/**
 * @displayName Place seed file
 * @strategicPurpose Gate for scripts/ingest/places.seed.json at the transform boundary, so a duplicate id or a dangling placeId anchor fails before any output is written.
 * @tacticalObjective Validates a non-empty array of PlaceSeed rows with unique ids, where every placeId anchor names another row that has coordinates.
 */
export const PlacesSeedSchema = z
  .array(PlaceSeedSchema)
  .min(1)
  .superRefine((rows, ctx) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate place id ${row.id}`,
        });
      }
      seen.add(row.id);
      if (row.anchor !== null && 'placeId' in row.anchor) {
        const target = byId.get(row.anchor.placeId);
        if (target === undefined || target.lat === null) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'anchor', 'placeId'],
            message: `placeId ${row.anchor.placeId} is not a seed row with coordinates`,
          });
        }
      }
    });
  });

/**
 * @displayName Place
 * @strategicPurpose One named place in local metres, the shape the browser reads. A place with verified false stays in the file for audit but never labels anything.
 * @tacticalObjective Validates id, name, kind, east and north (both null only when the position is unknown), radiusM, sourceUrl, verified, positionNote and positionSource. verified: true needs a position, and positionSource none means no position.
 */
export const PlaceSchema = z
  .strictObject({
    id: PlaceIdSchema,
    name: z.string().min(1),
    kind: PlaceKindSchema,
    east: z.number().nullable(),
    north: z.number().nullable(),
    radiusM: z.number().positive(),
    sourceUrl: HttpUrlSchema,
    verified: z.boolean(),
    positionNote: z.string().min(1),
    positionSource: z.enum(['coordinates', 'anchor', 'none']),
  })
  .superRefine((place, ctx) => {
    if ((place.east === null) !== (place.north === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['east'],
        message: 'east and north must both be set or both null',
      });
    }
    if ((place.positionSource === 'none') !== (place.east === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['positionSource'],
        message: 'positionSource none must match a null position',
      });
    }
    if (place.verified && place.east === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['verified'],
        message: 'a verified place needs a position',
      });
    }
  });
export type Place = z.infer<typeof PlaceSchema>;

/**
 * @displayName Places file
 * @strategicPurpose The emitted data/places.json: named places in local metres, tied to the frame they were projected with, so the browser can label signs without projecting anything.
 * @tacticalObjective Validates version, the sha256 of the frame.json used, generatedFrom (inputHash, codeCommit, effect) and a non-empty list of places with unique ids.
 */
export const PlacesFileSchema = z
  .strictObject({
    version: z.literal(1),
    frame: z.strictObject({ sha256: Sha256Schema }),
    generatedFrom: GeneratedFromSchema,
    places: z.array(PlaceSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.places.forEach((place, index) => {
      if (seen.has(place.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['places', index, 'id'],
          message: `duplicate place id ${place.id}`,
        });
      }
      seen.add(place.id);
    });
  });
export type PlacesFile = z.infer<typeof PlacesFileSchema>;

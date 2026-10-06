import { z } from 'zod';

const LatLonSchema = z.looseObject({ lat: z.number(), lon: z.number() });
const TagsSchema = z.record(z.string(), z.string());
const BoundsSchema = z.looseObject({
  minlat: z.number(),
  minlon: z.number(),
  maxlat: z.number(),
  maxlon: z.number(),
});

/**
 * @displayName Overpass node element
 * @strategicPurpose Parses a point (lift station, pylon) at the Overpass response boundary.
 * @tacticalObjective Requires id, lat and lon; tags are optional.
 */
export const OverpassNodeSchema = z.looseObject({
  type: z.literal('node'),
  id: z.number().int(),
  lat: z.number(),
  lon: z.number(),
  tags: TagsSchema.optional(),
});

/**
 * @displayName Overpass way element
 * @strategicPurpose Parses a line or ring (run, trail, lift) at the Overpass response boundary.
 * @tacticalObjective Requires id and integer node ids; geometry is optional here and its presence is a separate named check (OverpassNoGeometry).
 */
export const OverpassWaySchema = z.looseObject({
  type: z.literal('way'),
  id: z.number().int(),
  nodes: z.array(z.number().int()),
  geometry: z.array(LatLonSchema).optional(),
  bounds: BoundsSchema.optional(),
  tags: TagsSchema.optional(),
});

/**
 * @displayName Overpass relation member
 * @strategicPurpose Parses one member of a route relation, including its inline geometry.
 * @tacticalObjective Requires type, ref and role; way members carry geometry, node members carry lat and lon.
 */
export const OverpassMemberSchema = z.looseObject({
  type: z.enum(['node', 'way', 'relation']),
  ref: z.number().int(),
  role: z.string(),
  geometry: z.array(LatLonSchema).optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

/**
 * @displayName Overpass relation element
 * @strategicPurpose Parses a route relation (for example the mtb route) at the Overpass response boundary.
 * @tacticalObjective Requires id and members; member geometry covers whole members and may lie outside the bbox.
 */
export const OverpassRelationSchema = z.looseObject({
  type: z.literal('relation'),
  id: z.number().int(),
  members: z.array(OverpassMemberSchema),
  bounds: BoundsSchema.optional(),
  tags: TagsSchema.optional(),
});

/**
 * @displayName Overpass response envelope
 * @strategicPurpose The consumer gate for the Overpass response; fetch (emitter side) and #8 (consumer side) both parse with it.
 * @tacticalObjective Validates osm3s.timestamp_osm_base and a discriminated union of node, way and relation elements.
 */
export const OverpassEnvelopeSchema = z.looseObject({
  version: z.number(),
  generator: z.string(),
  osm3s: z.looseObject({ timestamp_osm_base: z.string().min(1) }),
  elements: z.array(
    z.discriminatedUnion('type', [OverpassNodeSchema, OverpassWaySchema, OverpassRelationSchema]),
  ),
});
export type OverpassEnvelope = z.infer<typeof OverpassEnvelopeSchema>;

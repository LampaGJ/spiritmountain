import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const RelPathSchema = z.string().min(1);

const BboxSchema = z.strictObject({
  south: z.number(),
  west: z.number(),
  north: z.number(),
  east: z.number(),
});
const GridBboxSchema = z.strictObject({
  xmin: z.number(),
  ymin: z.number(),
  xmax: z.number(),
  ymax: z.number(),
});

/**
 * @displayName Overpass manifest entry
 * @strategicPurpose Pins what was asked of Overpass and what came back, so the response can be verified byte for byte.
 * @tacticalObjective Records request, headers, status, fetch time, sha256 (the inputHash for #8), byte length and family counts.
 */
export const OverpassEntrySchema = z.strictObject({
  name: z.literal('overpass'),
  path: RelPathSchema,
  url: z.url(),
  method: z.literal('POST'),
  requestBody: z.string().min(1),
  requestHeaders: z.strictObject({ userAgent: z.string().min(1) }),
  httpStatus: z.literal(200),
  contentType: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  byteLength: z.number().int().positive(),
  sha256: Sha256Schema,
  osm3sTimestampBase: z.string().min(1),
  queryFileSha256: Sha256Schema,
  counts: z.strictObject({
    nodes: z.number().int().nonnegative(),
    ways: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    pisteType: z.number().int().positive(),
    aerialway: z.number().int().positive(),
    mtbScale: z.number().int().positive(),
  }),
});

/**
 * @displayName 3DEP manifest entry
 * @strategicPurpose Pins the elevation raster request and records the facts #9 must assert before using the raster.
 * @tacticalObjective Records request, sha256 (the inputHash for #9), size, requested and decoded bbox, byte order, nodata policy and observed value statistics.
 */
export const ThreeDepEntrySchema = z.strictObject({
  name: z.literal('3dep'),
  path: RelPathSchema,
  url: z.url(),
  method: z.literal('GET'),
  requestParams: z.record(z.string(), z.string()),
  httpStatus: z.literal(200),
  contentType: z.string().min(1),
  fetchedAt: z.iso.datetime(),
  byteLength: z.number().int().positive(),
  sha256: Sha256Schema,
  epsg: z.literal(26915),
  metresPerPixel: z.number().positive(),
  compression: z.literal('LZ77'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  requestedBbox26915: GridBboxSchema,
  decodedBbox26915: GridBboxSchema,
  byteOrder: z.enum(['little', 'big']),
  bitsPerSample: z.literal(32),
  sampleFormat: z.literal(3),
  noData: z.strictObject({
    declared: z.number().nullable(),
    floor: z.literal(-1000),
    policy: z.literal('abort if any pixel is non-finite or below floor'),
  }),
  stats: z.strictObject({
    min: z.number(),
    max: z.number(),
    nanCount: z.literal(0),
    nonFiniteCount: z.literal(0),
    belowFloorCount: z.literal(0),
  }),
});

/**
 * @displayName Raw input manifest
 * @strategicPurpose The provenance record for data/raw/: what was fetched, when, from where, and its hash. The sha256 values are the inputHash for replay records downstream; raw pins have no outputHash.
 * @tacticalObjective Validates data/raw/manifest.json; #8 and #9 parse it on read (consumer gate) and fetch.ts parses it before writing (emitter gate).
 */
export const ManifestSchema = z.strictObject({
  version: z.literal(1),
  bbox: BboxSchema,
  overpass: OverpassEntrySchema,
  threeDep: ThreeDepEntrySchema,
});
export type Manifest = z.infer<typeof ManifestSchema>;

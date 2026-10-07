import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Buildings manifest
 * @strategicPurpose Pins what was asked of Overpass for building footprints and what came back, so the buildings pin is a verifiable raw input that is separate from the areas pin and cannot change its counts.
 * @tacticalObjective Validates data/raw/buildings-manifest.json: request body and headers, status, content type, fetch time, sha256 (the inputHash for buildings.ts), byte length, the query hash and counts of ways, relations and elements carrying a building tag.
 *
 * Declared effect: preserves. The script writes the response bytes unchanged; the manifest only describes them.
 */
export const BuildingsManifestSchema = z.strictObject({
  version: z.literal(1),
  name: z.literal('overpass-buildings'),
  path: z.string().min(1),
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
    ways: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    buildingTagged: z.number().int().positive(),
    manMadeTagged: z.number().int().nonnegative(),
  }),
});
export type BuildingsManifest = z.infer<typeof BuildingsManifestSchema>;

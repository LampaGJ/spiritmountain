import { z } from 'zod';

/**
 * @displayName Sky manifest
 * @strategicPurpose Pins which Poly Haven HDRI the scene sky comes from and what came back, so the sky is a verifiable raw input with its licence and credits on record.
 * @tacticalObjective Validates data/raw/sky-manifest.json: asset id, variant, request URL, status, fetch time, byte length, sha256, the md5 and size the Poly Haven files API advertised, RGBE pixel size, licence CC0 and authors.
 *
 * Declared effect: preserves. The script writes the response bytes unchanged; the manifest only describes them.
 * Consumer note: the file is a Radiance .hdr (RGBE). Phase 2 loads data/raw/sky.hdr with three's RGBELoader and
 * EquirectangularReflectionMapping, and assigns the texture to both scene.background and scene.environment.
 */
export const SkyManifestSchema = z.strictObject({
  version: z.literal(1),
  name: z.literal('sky'),
  path: z.string().min(1),
  asset: z.literal('kloofendal_48d_partly_cloudy_puresky'),
  variant: z.enum(['1k', '2k', '4k']),
  format: z.literal('hdr'),
  url: z.url(),
  method: z.literal('GET'),
  requestHeaders: z.strictObject({ userAgent: z.string().min(1) }),
  httpStatus: z.literal(200),
  fetchedAt: z.iso.datetime(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  apiSize: z.number().int().positive(),
  md5: z.string().regex(/^[0-9a-f]{32}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  license: z.literal('CC0'),
  authors: z.record(z.string().min(1), z.string().min(1)),
});
export type SkyManifest = z.infer<typeof SkyManifestSchema>;

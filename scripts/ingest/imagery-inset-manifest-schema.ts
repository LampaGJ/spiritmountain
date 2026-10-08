import { z } from 'zod';
import { GridBboxSchema, imageHeightFor } from './imagery-manifest-schema';

const LocalRectSchema = z
  .strictObject({
    minEast: z.number(),
    minNorth: z.number(),
    maxEast: z.number(),
    maxNorth: z.number(),
  })
  .refine((r) => r.maxEast > r.minEast && r.maxNorth > r.minNorth, {
    error: 'local rect must have max > min',
  });

export type InsetLocalRect = z.infer<typeof LocalRectSchema>;

/**
 * @displayName Imagery inset manifest
 * @strategicPurpose Pins what was asked of the NAIP ImageServer for the native-resolution inset around the resort and what came back, so the inset texture is a verifiable raw input and its place on the terrain is provably the rect the shader mixes it into.
 * @tacticalObjective Validates data/raw/imagery-inset-manifest.json: request URL and params (including compressionQuality), status, content type, fetch time, sha256, byte length, the EPSG:26915 bbox, the frame origin, the same box in local metres, pixel size, and that bbox minus origin equals the local rect, height keeps the box aspect, and metresPerPixel agrees with bbox and width.
 *
 * Declared effect: preserves. The script writes the response bytes unchanged; the manifest only describes them.
 */
export const ImageryInsetManifestSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.literal('naip-inset'),
    path: z.string().min(1),
    url: z.url(),
    method: z.literal('GET'),
    params: z.record(z.string(), z.string()),
    requestHeaders: z.strictObject({ userAgent: z.string().min(1) }),
    httpStatus: z.literal(200),
    contentType: z.literal('image/jpeg'),
    fetchedAt: z.iso.datetime(),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    epsg: z.literal(26915),
    origin: z.strictObject({ easting: z.number(), northing: z.number() }),
    bbox: GridBboxSchema,
    localRect: LocalRectSchema,
    compressionQuality: z.number().int().min(1).max(100),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    metresPerPixel: z.number().positive(),
  })
  .superRefine((m, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const expectedHeight = imageHeightFor(m.bbox, m.width);
    if (m.height !== expectedHeight) {
      issue(
        'height',
        `height ${m.height} breaks the box aspect; expected ${expectedHeight} for width ${m.width}`,
      );
    }
    const expectedMpp = (m.bbox.xmax - m.bbox.xmin) / m.width;
    if (Math.abs(m.metresPerPixel - expectedMpp) > 1e-6) {
      issue(
        'metresPerPixel',
        `metresPerPixel ${m.metresPerPixel} disagrees with bbox and width (${expectedMpp})`,
      );
    }
    const local = {
      minEast: m.bbox.xmin - m.origin.easting,
      minNorth: m.bbox.ymin - m.origin.northing,
      maxEast: m.bbox.xmax - m.origin.easting,
      maxNorth: m.bbox.ymax - m.origin.northing,
    };
    for (const key of Object.keys(local) as (keyof typeof local)[]) {
      if (Math.abs(local[key] - m.localRect[key]) > 1e-6) {
        issue(
          'localRect',
          `localRect.${key} ${m.localRect[key]} is not bbox minus origin (${local[key]})`,
        );
      }
    }
    if (m.params['compressionQuality'] !== String(m.compressionQuality)) {
      issue(
        'compressionQuality',
        `params.compressionQuality ${m.params['compressionQuality']} disagrees with ${m.compressionQuality}`,
      );
    }
  });
export type ImageryInsetManifest = z.infer<typeof ImageryInsetManifestSchema>;

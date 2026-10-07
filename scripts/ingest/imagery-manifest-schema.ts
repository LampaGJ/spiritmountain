import { z } from 'zod';

const GridBboxSchema = z
  .strictObject({
    xmin: z.number(),
    ymin: z.number(),
    xmax: z.number(),
    ymax: z.number(),
  })
  .refine((b) => b.xmax > b.xmin && b.ymax > b.ymin, { error: 'bbox must have max > min' });

export type GridBbox = z.infer<typeof GridBboxSchema>;

/** Image height in pixels that keeps the aspect of a EPSG:26915 box at the given width. */
export function imageHeightFor(bbox: GridBbox, width: number): number {
  return Math.round((width * (bbox.ymax - bbox.ymin)) / (bbox.xmax - bbox.xmin));
}

/**
 * @displayName Imagery manifest
 * @strategicPurpose Pins what was asked of the NAIP ImageServer and what came back, so the terrain texture is a verifiable raw input and its extent is provably the heightfield's extent.
 * @tacticalObjective Validates data/raw/imagery-manifest.json: request URL and params, status, content type, fetch time, sha256, byte length, the EPSG:26915 bbox, pixel size, and that height keeps the box aspect and metresPerPixel agrees with bbox and width.
 *
 * Declared effect: preserves. The script writes the response bytes unchanged; the manifest only describes them.
 */
export const ImageryManifestSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.literal('naip'),
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
    bbox: GridBboxSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    metresPerPixel: z.number().positive(),
  })
  .superRefine((m, ctx) => {
    const expectedHeight = imageHeightFor(m.bbox, m.width);
    if (m.height !== expectedHeight) {
      ctx.addIssue({
        code: 'custom',
        path: ['height'],
        message: `height ${m.height} breaks the box aspect; expected ${expectedHeight} for width ${m.width}`,
      });
    }
    const expectedMpp = (m.bbox.xmax - m.bbox.xmin) / m.width;
    if (Math.abs(m.metresPerPixel - expectedMpp) > 1e-6) {
      ctx.addIssue({
        code: 'custom',
        path: ['metresPerPixel'],
        message: `metresPerPixel ${m.metresPerPixel} disagrees with bbox and width (${expectedMpp})`,
      });
    }
  });
export type ImageryManifest = z.infer<typeof ImageryManifestSchema>;

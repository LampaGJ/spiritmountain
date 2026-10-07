import { z } from 'zod';

const Rgb255Schema = z.strictObject({
  r: z.number().min(0).max(255),
  g: z.number().min(0).max(255),
  b: z.number().min(0).max(255),
});
const RgbLinearSchema = z.strictObject({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
});

/**
 * @displayName Imagery colour statistics
 * @strategicPurpose Gives the scene the real average ground tone of the NAIP orthoimage, so the plane beyond the faded tiles matches the photograph without the browser decoding a 4000 x 3879 JPEG.
 * @tacticalObjective Validates data/imagery-stats.json: the pinned source path and sha256, pixel count and size, the mean R, G, B in sRGB 0-255, and the mean in linear light 0-1 (sRGB-to-linear applied per pixel, then averaged), which is the value a three.js material colour takes.
 *
 * Declared effect: reduces (about 15.5 million pixels become six numbers).
 */
export const ImageryStatsSchema = z
  .strictObject({
    version: z.literal(1),
    source: z.strictObject({
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixelCount: z.number().int().positive(),
    meanSrgb255: Rgb255Schema,
    meanLinear: RgbLinearSchema,
  })
  .refine((s) => s.pixelCount === s.width * s.height, {
    error: 'pixelCount must equal width * height',
  });
export type ImageryStats = z.infer<typeof ImageryStatsSchema>;

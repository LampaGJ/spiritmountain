import { z } from 'zod';

const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters (sha256)' });

const SourceSchema = z.strictObject({ path: z.string().min(1), sha256: Sha256Schema });

/**
 * @displayName Canopy height summary header
 * @strategicPurpose The one contract for data/canopy.json, shared by the ingest transform that writes it and the browser loader that reads it, so trail curtains read tree height from 100 kB instead of the 18 MB first-return raster.
 * @tacticalObjective Validates the grid size, the top-left corner origin in local metres, the cell size, the byte scale (metres per step) and clamp, the byte length, the sha256 of data/canopy.u8, and the sha256 of each pinned source (square first-return raster, bare-earth terrain header and raster).
 *
 * Declared effect: reduces (about 2.9 million first-return cells become about 120 thousand bytes).
 */
export const CanopyHeaderSchema = z
  .strictObject({
    version: z.literal(1),
    width: z.int().positive(),
    height: z.int().positive(),
    /** Local metres east of the frame origin: top-left corner of the top-left cell. */
    originX: z.number(),
    /** Local metres north of the frame origin: top-left corner of the top-left cell. */
    originY: z.number(),
    originCorner: z.literal('top-left-of-top-left-cell'),
    cellSizeM: z.number().positive(),
    rowOrder: z.literal('north-to-south'),
    columnOrder: z.literal('west-to-east'),
    dtype: z.literal('uint8'),
    /** Metres of canopy height per byte step. */
    scaleM: z.number().positive(),
    /** Canopy height clamp, metres. */
    maxM: z.number().positive(),
    reduction: z.literal('block-max'),
    byteLength: z.int().positive(),
    u8Sha256: Sha256Schema,
    sources: z.strictObject({
      surfaceHeader: SourceSchema,
      surface: SourceSchema,
      terrainHeader: SourceSchema,
      terrain: SourceSchema,
    }),
  })
  .superRefine((header, ctx) => {
    if (header.byteLength !== header.width * header.height) {
      ctx.addIssue({
        code: 'custom',
        path: ['byteLength'],
        message: 'byteLength must equal width * height',
      });
    }
    if (header.maxM / header.scaleM > 255) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxM'],
        message: 'maxM / scaleM must fit in one byte (255)',
      });
    }
  });
export type CanopyHeader = z.infer<typeof CanopyHeaderSchema>;

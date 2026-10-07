import { z } from 'zod';

const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters (sha256)' });

/**
 * @displayName Terrain header
 * @strategicPurpose The one contract for data/terrain.json, shared by the ingest transform that writes it and the browser loader that reads it, so the heightfield is never interpreted from a guessed layout.
 * @tacticalObjective Validates grid size, the named top-left origin corner in local metres, per-axis cell size, row, column and byte order, elevation range (minElev and maxElev are exact Math.fround Float32 values, not rounded), nodata rule and fill count, and the frame and source sha256 references.
 */
export const TerrainHeaderSchema = z
  .strictObject({
    version: z.literal(1),
    width: z.int().positive(),
    height: z.int().positive(),
    /** Local metres east of the frame origin: top-left corner of the top-left pixel. */
    originX: z.number(),
    /** Local metres north of the frame origin: top-left corner of the top-left pixel. */
    originY: z.number(),
    originCorner: z.literal('top-left-of-top-left-pixel'),
    cellSizeX: z.number().positive(),
    cellSizeY: z.number().positive(),
    rowOrder: z.literal('north-to-south'),
    columnOrder: z.literal('west-to-east'),
    byteOrder: z.literal('LE'),
    dtype: z.literal('float32'),
    byteLength: z.int().positive(),
    minElev: z.number(),
    maxElev: z.number(),
    plausibleRangeM: z.tuple([z.number(), z.number()]),
    nodataValue: z.number().nullable(),
    nodataRule: z.enum(['gdal-nodata-tag-or-non-finite', 'non-finite-only']),
    fillMethod: z.literal('chebyshev-bfs-fixed-order'),
    nodataFilled: z.int().nonnegative(),
    frame: z.strictObject({ file: z.literal('data/frame.json'), sha256: Sha256Schema }),
    source: z.strictObject({
      path: z
        .string()
        .regex(/^data\/raw\/(3dep\.tif|surface-core\.tif|context\/-?\d+_-?\d+\.tif)$/, {
          error:
            'source.path must be data/raw/3dep.tif, data/raw/surface-core.tif or data/raw/context/<i>_<j>.tif',
        }),
      sha256: Sha256Schema,
    }),
  })
  .superRefine((header, ctx) => {
    if (header.byteLength !== header.width * header.height * 4) {
      ctx.addIssue({
        code: 'custom',
        path: ['byteLength'],
        message: 'byteLength must equal width * height * 4',
      });
    }
    if (header.minElev > header.maxElev) {
      ctx.addIssue({
        code: 'custom',
        path: ['minElev'],
        message: 'minElev must not exceed maxElev',
      });
    }
    if (header.nodataFilled > header.width * header.height) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodataFilled'],
        message: 'nodataFilled must not exceed the pixel count',
      });
    }
  });
export type TerrainHeader = z.infer<typeof TerrainHeaderSchema>;

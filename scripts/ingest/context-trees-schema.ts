import { z } from 'zod';
import { TREE_FIELDS, TREE_RECORD_BYTES, TREE_RECORD_FLOATS } from './trees-schema';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Context trees header
 * @strategicPurpose Tells a reader exactly how to read data/context-trees.bin (record layout, counts, byte length) and which pinned inputs and constants produced it, so the browser never guesses the layout of the far-field forest.
 * @tacticalObjective Validates the count, the 9-float record layout shared with trees.bin, byte length (count * 36), tree counts per class and per archetype (each summing to count), the placement constants, and the sha256 of every source file.
 */
export const ContextTreesHeaderSchema = z
  .strictObject({
    version: z.literal(1),
    count: z.int().nonnegative(),
    recordFloats: z.literal(TREE_RECORD_FLOATS),
    byteOrder: z.literal('LE'),
    dtype: z.literal('float32'),
    fields: z.tuple([
      z.literal(TREE_FIELDS[0]),
      z.literal(TREE_FIELDS[1]),
      z.literal(TREE_FIELDS[2]),
      z.literal(TREE_FIELDS[3]),
      z.literal(TREE_FIELDS[4]),
      z.literal(TREE_FIELDS[5]),
      z.literal(TREE_FIELDS[6]),
      z.literal(TREE_FIELDS[7]),
      z.literal(TREE_FIELDS[8]),
    ]),
    byteLength: z.int().nonnegative(),
    types: z.strictObject({ broadleaf: z.int().nonnegative(), conifer: z.int().nonnegative() }),
    archetypes: z.array(z.int().nonnegative()).length(6),
    params: z.strictObject({
      seed: z.int(),
      blockM: z.number().positive(),
      greenMin: z.number(),
      greenFull: z.number(),
      baseDensity: z.number().min(0).max(1),
      innerM: z.number().nonnegative(),
      outerM: z.number().positive(),
      jitterM: z.number().nonnegative(),
      heightMinM: z.number().positive(),
      heightMaxM: z.number().positive(),
      heightJitter: z.number().nonnegative(),
      broadleafShare: z.number().min(0).max(1),
      darken: z.number().positive(),
    }),
    /** Blocks that passed the greenness test and lie outside the core window, before the radial thinning. */
    forestBlocks: z.int().nonnegative(),
    frame: z.strictObject({ file: z.literal('data/frame.json'), sha256: Sha256Schema }),
    sources: z.array(z.strictObject({ path: z.string().min(1), sha256: Sha256Schema })).min(1),
  })
  .superRefine((h, ctx) => {
    if (h.byteLength !== h.count * TREE_RECORD_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['byteLength'],
        message: `byteLength must equal count * ${TREE_RECORD_BYTES}`,
      });
    }
    if (h.types.broadleaf + h.types.conifer !== h.count) {
      ctx.addIssue({ code: 'custom', path: ['types'], message: 'types must sum to count' });
    }
    if (h.archetypes.reduce((p, q) => p + q, 0) !== h.count) {
      ctx.addIssue({
        code: 'custom',
        path: ['archetypes'],
        message: 'archetypes must sum to count',
      });
    }
  });
export type ContextTreesHeader = z.infer<typeof ContextTreesHeaderSchema>;

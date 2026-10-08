import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const RgbUnitSchema = z.strictObject({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
});

/**
 * @displayName Tree colour statistics
 * @strategicPurpose Gives the scene the average colour of the simulated and far-field trees, so the ground plane beyond the faded tiles reads as forest meeting the horizon instead of the NAIP grey-green.
 * @tacticalObjective Validates data/tree-stats.json: the pinned tree files it was reduced from (path and sha256), the tree count, the mean colour in linear light 0-1 (each tree's sRGB colour converted to linear, then averaged with equal weight per tree; the value a three.js material colour takes), and meanSrgb, the sRGB encoding of that linear mean (0-1, the colour as displayed).
 *
 * Declared effect: reduces (about 200 thousand tree records become six numbers).
 */
export const TreeStatsSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(z.strictObject({ path: z.string().min(1), sha256: Sha256Schema })).min(1),
  count: z.int().positive(),
  meanLinear: RgbUnitSchema,
  meanSrgb: RgbUnitSchema,
});
export type TreeStats = z.infer<typeof TreeStatsSchema>;

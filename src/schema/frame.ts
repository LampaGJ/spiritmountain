import { z } from 'zod';

/**
 * @displayName Frame file
 * @strategicPurpose Tells the browser loader and every transform which metric frame the data uses; lives in src/schema so the loader never imports from scripts/.
 * @tacticalObjective Validates data/frame.json: EPSG code, proj4 definition, origin, centre and bbox.
 */
export const FrameSchema = z.strictObject({
  version: z.literal(1),
  epsg: z.literal(26915),
  proj4Def: z.string().min(1),
  origin: z.strictObject({ easting: z.number(), northing: z.number() }),
  centre: z.strictObject({ lon: z.number(), lat: z.number() }),
  bbox: z.strictObject({
    south: z.number(),
    west: z.number(),
    north: z.number(),
    east: z.number(),
  }),
  axes: z.literal('x east, y north, z elevation; metres; local = absolute UTM minus origin'),
});
export type Frame = z.infer<typeof FrameSchema>;

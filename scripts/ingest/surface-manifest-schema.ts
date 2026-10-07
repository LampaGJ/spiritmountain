import { z } from 'zod';

const BoxSchema = z
  .strictObject({ xmin: z.number(), ymin: z.number(), xmax: z.number(), ymax: z.number() })
  .refine((b) => b.xmax > b.xmin && b.ymax > b.ymin, { error: 'bbox must have max > min' });

/**
 * @displayName Resolved PDAL pipeline
 * @strategicPurpose Records the exact PDAL stages that produced the surface raster, so the pin can be rerun and audited without guessing parameters.
 * @tacticalObjective Validates a non-empty array of stage objects, each with a string type, under the pipeline key.
 */
export const ResolvedPipelineSchema = z.strictObject({
  pipeline: z.array(z.looseObject({ type: z.string().min(1) })).min(1),
});

/**
 * @displayName Surface manifest
 * @strategicPurpose Pins what was asked of the public USGS EPT point cloud and what came back, so the first-return surface raster is a verifiable raw input whose extent is provably aligned to the bare-earth grid.
 * @tacticalObjective Validates data/raw/surface-manifest.json: the EPT url, PDAL version, resolved pipeline, EPSG:26915 and EPSG:3857 windows, points read and first returns kept, pixel size, byte length, sha256 and seconds, and that width and height agree with the window and resolution.
 *
 * Declared effect: reduces (many points become one maximum per cell). Not byte-replayable offline: the pin is the raster, not the point cloud.
 */
export const SurfaceManifestSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.enum(['surface-core', 'surface-square']),
    path: z.string().min(1),
    eptUrl: z.url(),
    /** Further point clouds read and merged (the square window also reads MN_LakeSuperior_1_2021). */
    extraEptUrls: z.array(z.url()).optional(),
    pdalVersion: z.string().min(1),
    pipeline: ResolvedPipelineSchema,
    epsg: z.literal(26915),
    window26915: BoxSchema,
    window3857: BoxSchema,
    resolutionM: z.number().positive(),
    width: z.int().positive(),
    height: z.int().positive(),
    pointsRead: z.int().nonnegative(),
    firstReturnsKept: z.int().nonnegative(),
    byteLength: z.int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    seconds: z.number().nonnegative(),
    fetchedAt: z.iso.datetime(),
    /** Set when the 1 m raster exceeded the size cap and the 2 m rerun was kept. */
    firstAttemptBytes: z.int().positive().nullable(),
  })
  .superRefine((m, ctx) => {
    const w = m.window26915;
    for (const [axis, size, span] of [
      ['width', m.width, w.xmax - w.xmin],
      ['height', m.height, w.ymax - w.ymin],
    ] as const) {
      // The raster has ceil(span / resolution) cells; it overhangs the window by less than one cell when span is not a multiple.
      if (size !== Math.ceil(span / m.resolutionM - 1e-9)) {
        ctx.addIssue({
          code: 'custom',
          path: [axis],
          message: `${axis} ${size} x ${m.resolutionM} m does not cover the window span ${span}`,
        });
      }
    }
    if (m.firstReturnsKept > m.pointsRead) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstReturnsKept'],
        message: 'firstReturnsKept must not exceed pointsRead',
      });
    }
  });
export type SurfaceManifest = z.infer<typeof SurfaceManifestSchema>;

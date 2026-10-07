import { z } from 'zod';
import { CONTEXT_TILES, tileBox, tileKey } from './context-tiles';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const BoxSchema = z
  .strictObject({ xmin: z.number(), ymin: z.number(), xmax: z.number(), ymax: z.number() })
  .refine((b) => b.xmax > b.xmin && b.ymax > b.ymin, { error: 'bbox must have max > min' });

/**
 * @displayName Context pinned file entry
 * @strategicPurpose Pins one response of one context-tile request (a 3DEP tif or a NAIP jpg) so it can be verified byte for byte and the request replayed.
 * @tacticalObjective Validates path, request url and params, status, content type, fetch time, byte length, sha256, pixel size and metres per pixel.
 */
export const ContextFileSchema = z.strictObject({
  path: z.string().min(1),
  url: z.url(),
  method: z.literal('GET'),
  params: z.record(z.string(), z.string()),
  httpStatus: z.literal(200),
  contentType: z.enum(['image/tiff', 'image/jpeg']),
  fetchedAt: z.iso.datetime(),
  byteLength: z.number().int().positive(),
  sha256: Sha256Schema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  metresPerPixel: z.number().positive(),
});

/**
 * @displayName Context manifest
 * @strategicPurpose Pins the 12 low-resolution context tiles (terrain and imagery) as raw inputs, so the context ring replays offline and its extent is provably the tile table's.
 * @tacticalObjective Validates data/raw/context/manifest.json: one entry per tile with the tile's EPSG:26915 bbox (which must equal tileBox(i, j)), a terrain file and an imagery file, no duplicate or unknown tiles, and metresPerPixel that agrees with bbox and width.
 *
 * Declared effect: preserves. The script writes the response bytes unchanged; the manifest only describes them.
 */
export const ContextManifestSchema = z
  .strictObject({
    version: z.literal(1),
    epsg: z.literal(26915),
    requestHeaders: z.strictObject({ userAgent: z.string().min(1) }),
    tiles: z.array(
      z.strictObject({
        i: z.int(),
        j: z.int(),
        bbox: BoxSchema,
        terrain: ContextFileSchema,
        imagery: ContextFileSchema,
      }),
    ),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.tiles.forEach((tile, index) => {
      const key = tileKey(tile.i, tile.j);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['tiles', index], message: `duplicate tile ${key}` });
      }
      seen.add(key);
      if (!CONTEXT_TILES.some(([i, j]) => i === tile.i && j === tile.j)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tiles', index],
          message: `tile ${key} is not in the tile table`,
        });
        return;
      }
      const expected = tileBox(tile.i, tile.j);
      for (const side of ['xmin', 'ymin', 'xmax', 'ymax'] as const) {
        if (tile.bbox[side] !== expected[side]) {
          ctx.addIssue({
            code: 'custom',
            path: ['tiles', index, 'bbox', side],
            message: `tile ${key} ${side} ${tile.bbox[side]} differs from tileBox ${expected[side]}`,
          });
        }
      }
      for (const kind of ['terrain', 'imagery'] as const) {
        const file = tile[kind];
        const mpp = (tile.bbox.xmax - tile.bbox.xmin) / file.width;
        if (Math.abs(file.metresPerPixel - mpp) > 1e-6) {
          ctx.addIssue({
            code: 'custom',
            path: ['tiles', index, kind, 'metresPerPixel'],
            message: `metresPerPixel ${file.metresPerPixel} disagrees with bbox and width (${mpp})`,
          });
        }
      }
    });
  });
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

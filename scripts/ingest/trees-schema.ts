import { z } from 'zod';

/** Float32 fields of one tree record, in order. */
export const TREE_FIELDS = [
  'east',
  'north',
  'groundElev',
  'height',
  'type',
  'rotation',
  'r',
  'g',
  'b',
] as const;
export const TREE_RECORD_FLOATS = TREE_FIELDS.length;
export const TREE_RECORD_BYTES = TREE_RECORD_FLOATS * 4;

/** Archetype ids stored in the `type` field: 0 to 3 broadleaf, 4 and 5 conifer. */
export const ARCHETYPE_COUNT = 6;
export const BROADLEAF_ARCHETYPES = [0, 1, 2, 3] as const;
export const CONIFER_ARCHETYPES = [4, 5] as const;
export const isConiferArchetype = (id: number): boolean => id >= 4;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Trees header
 * @strategicPurpose Tells a reader exactly how to read data/trees.bin (record layout, counts, byte length) and which pinned inputs and constants produced it, so the browser never guesses the layout.
 * @tacticalObjective Validates the count, 9-float record layout, byte length (count * 36), tree counts per class and per archetype (each summing to count), the placement constants, and sha256 of every source file.
 */
export const TreesHeaderSchema = z
  .strictObject({
    version: z.literal(1),
    count: z.int().nonnegative(),
    recordFloats: z.literal(TREE_RECORD_FLOATS),
    byteOrder: z.literal('LE'),
    dtype: z.literal('float32'),
    fields: z.tuple([
      z.literal('east'),
      z.literal('north'),
      z.literal('groundElev'),
      z.literal('height'),
      z.literal('type'),
      z.literal('rotation'),
      z.literal('r'),
      z.literal('g'),
      z.literal('b'),
    ]),
    byteLength: z.int().nonnegative(),
    /** Colour channels are sRGB 0 to 1 (photo pixel darkened). Type is the archetype id. */
    types: z.strictObject({ broadleaf: z.int().nonnegative(), conifer: z.int().nonnegative() }),
    archetypes: z.array(z.int().nonnegative()).length(ARCHETYPE_COUNT),
    params: z.strictObject({
      seed: z.int(),
      density: z.number().min(0).max(1),
      blockCells: z.int().positive(),
      blockMinCanopyCells: z.int().positive(),
      canopyMinChmM: z.number(),
      greenMargin: z.number(),
      jitterM: z.number(),
      heightMinM: z.number(),
      heightMaxM: z.number(),
      heightJitter: z.number(),
      peakDeltaM: z.number(),
      typeOverride: z.number(),
      broadleafShare: z.number(),
      darken: z.number(),
    }),
    canopyCells: z.int().nonnegative(),
    nocanopyCellsReplaced: z.int().nonnegative(),
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
export type TreesHeader = z.infer<typeof TreesHeaderSchema>;

/** One tree, in the units the record stores (local metres, sRGB 0 to 1). */
export interface TreeRecord {
  east: number;
  north: number;
  groundElev: number;
  height: number;
  /** Archetype id 0 to 5. */
  type: number;
  rotation: number;
  r: number;
  g: number;
  b: number;
}

/** Packs records to little-endian Float32 bytes, TREE_RECORD_BYTES each. */
export function packTrees(trees: readonly TreeRecord[]): Uint8Array {
  const bytes = new Uint8Array(trees.length * TREE_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  trees.forEach((t, i) => {
    TREE_FIELDS.forEach((field, f) => {
      view.setFloat32(i * TREE_RECORD_BYTES + f * 4, t[field], true);
    });
  });
  return bytes;
}

/** Reads little-endian Float32 records back; the inverse of packTrees (values are Float32-rounded). */
export function unpackTrees(buffer: ArrayBuffer, count: number): TreeRecord[] {
  if (buffer.byteLength !== count * TREE_RECORD_BYTES) {
    throw new Error(
      `trees.bin is ${buffer.byteLength} bytes, expected ${count * TREE_RECORD_BYTES} for ${count} trees`,
    );
  }
  const view = new DataView(buffer);
  const out: TreeRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = (f: number): number => view.getFloat32(i * TREE_RECORD_BYTES + f * 4, true);
    out.push({
      east: at(0),
      north: at(1),
      groundElev: at(2),
      height: at(3),
      type: at(4),
      rotation: at(5),
      r: at(6),
      g: at(7),
      b: at(8),
    });
  }
  return out;
}

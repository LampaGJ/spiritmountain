import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';

/**
 * @displayName Building dropped reason
 * @strategicPurpose Closed list of reasons an input element or one of its rings did not become a building, so every loss is named and countable.
 * @tacticalObjective Closed enum of the drop reasons.
 */
export const BuildingDroppedReasonSchema = z.enum([
  'building-no',
  'no-kind',
  'no-polygon',
  'degenerate-ring',
  'outside-terrain-box',
  'outside-radius',
]);

/**
 * @displayName Building dropped entry
 * @strategicPurpose Records one element, or one outer ring of a multipolygon, that produced no building, with the offending value.
 * @tacticalObjective Validates id (an element key such as way/1, or relation/N#k for one ring), reason and an optional detail.
 */
export const BuildingDroppedEntrySchema = z.strictObject({
  id: z.string().min(1),
  reason: BuildingDroppedReasonSchema,
  detail: z.string().min(1).optional(),
});

/**
 * @displayName Buildings replay record
 * @strategicPurpose Proves data/buildings.geojson replays from the pinned Overpass buildings file: the shared replay record plus the filter parameters, counts and dropped list that make the reduction auditable.
 * @tacticalObjective Extends ReplayRecordSchema with toolVersions, lockSubtreeSha256, the terrain box and radius filter that were applied, counts (elements in, elements produced, elements dropped, features, per height source), droppedCounts per reason and the dropped list.
 */
export const BuildingsReplaySchema = ReplayRecordSchema.extend({
  toolVersions: z.strictObject({
    osmtogeojson: z.string().min(1),
    proj4: z.string().min(1),
  }),
  lockSubtreeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  terrainBox: z.strictObject({
    xmin: z.number(),
    ymin: z.number(),
    xmax: z.number(),
    ymax: z.number(),
  }),
  radiusM: z.number().positive().nullable(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  droppedCounts: z.record(z.string(), z.number().int().nonnegative()),
  dropped: z.array(BuildingDroppedEntrySchema),
});
export type BuildingsReplay = z.infer<typeof BuildingsReplaySchema>;
export type BuildingDroppedEntry = z.infer<typeof BuildingDroppedEntrySchema>;

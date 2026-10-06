import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';

/**
 * @displayName Dropped reason
 * @strategicPurpose Closed list of reasons an input element did not become an area, so every loss is named and countable.
 * @tacticalObjective Closed enum of the drop reasons.
 */
export const DroppedReasonSchema = z.enum([
  'node-pylon',
  'node-station',
  'node-other',
  'relation-unmapped',
  'relation-no-new-members',
  'unmapped-piste-type',
  'unmapped-tags',
  'unsupported-geometry',
  'outside-bbox',
  'duplicate-member',
  'unsupported-member',
]);

/**
 * @displayName Dropped entry
 * @strategicPurpose Records one element or relation member that produced no area, with the offending value.
 * @tacticalObjective Validates id (an element key such as node/1, or relation/N#way/M for a relation member), reason, and an optional detail.
 */
export const DroppedEntrySchema = z.strictObject({
  id: z.string().min(1),
  reason: DroppedReasonSchema,
  detail: z.string().min(1).optional(),
});

/**
 * @displayName Areas replay record
 * @strategicPurpose Proves data/areas.geojson replays from the pinned Overpass file: the shared replay record plus the dropped list and counts that make the reduction auditable.
 * @tacticalObjective Extends ReplayRecordSchema with toolVersions (package versions only), lockSubtreeSha256, counts per area kind, droppedCounts per reason, and the dropped list.
 */
export const AreasReplaySchema = ReplayRecordSchema.extend({
  toolVersions: z.strictObject({
    osmtogeojson: z.string().min(1),
    proj4: z.string().min(1),
  }),
  lockSubtreeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  droppedCounts: z.record(z.string(), z.number().int().nonnegative()),
  dropped: z.array(DroppedEntrySchema),
});
export type AreasReplay = z.infer<typeof AreasReplaySchema>;
export type DroppedEntry = z.infer<typeof DroppedEntrySchema>;

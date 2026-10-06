import { z } from 'zod';
import { AreaIdSchema } from './area';

/**
 * @displayName Activity
 * @strategicPurpose The activities a stakeholder review filters and discusses.
 * @tacticalObjective Closed enum of twelve values: the principal's eleven plus adaptive, which the real organizations seed file uses; expected to grow.
 */
export const ActivitySchema = z.enum([
  'alpine-ski',
  'snowboard',
  'nordic-classic',
  'nordic-skate',
  'snowshoe',
  'fat-bike',
  'mountain-bike',
  'hike',
  'trail-run',
  'tubing',
  'lift-ride',
  'adaptive',
]);

/**
 * @displayName Season
 * @strategicPurpose Supports the seasonal cross-section view.
 * @tacticalObjective Closed enum of the four seasons.
 */
export const SeasonSchema = z.enum(['winter', 'spring', 'summer', 'fall']);

/**
 * @displayName Stakeholder role
 * @strategicPurpose Records how an organization relates to an area without free text.
 * @tacticalObjective Closed enum of the five roles; no role is ever defaulted.
 */
export const StakeholderRoleSchema = z.enum([
  'maintains',
  'operates',
  'programs',
  'funds',
  'advocates',
]);

/**
 * @displayName Activity entry
 * @strategicPurpose Says which activity happens on an area and when.
 * @tacticalObjective Validates activity, a possibly empty season list, and notes.
 */
export const ActivityEntrySchema = z.strictObject({
  activity: ActivitySchema,
  seasons: z.array(SeasonSchema),
  notes: z.string(),
});

/**
 * @displayName Stakeholder link
 * @strategicPurpose Ties an organization to an area with a role.
 * @tacticalObjective Validates orgId and role.
 */
export const StakeholderLinkSchema = z.strictObject({
  orgId: z.string().min(1),
  role: StakeholderRoleSchema,
});

/**
 * @displayName Annotation
 * @strategicPurpose Human-readable knowledge attached to one area, keyed by its stable id.
 * @tacticalObjective Validates areaId (same pattern as Area id), activities, stakeholders and notes (empty string allowed).
 */
export const AnnotationSchema = z.strictObject({
  areaId: AreaIdSchema,
  activities: z.array(ActivityEntrySchema),
  stakeholders: z.array(StakeholderLinkSchema),
  notes: z.string(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

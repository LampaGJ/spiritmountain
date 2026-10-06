import { z } from 'zod';
import { ActivitySchema } from './annotation';

/**
 * @displayName Organization type
 * @strategicPurpose Classifies stakeholders so the panel and later filters can group them.
 * @tacticalObjective Closed enum of six types: the spec's five plus state-agency, which the real seed file uses for two rows.
 */
export const OrganizationTypeSchema = z.enum([
  'nonprofit',
  'authority',
  'municipal',
  'club',
  'business',
  'state-agency',
]);

/** An http or https url only; javascript: and file: are rejected because the panel may render it as a link. */
const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * @displayName Organization
 * @strategicPurpose Names a stakeholder once so annotations reference it by id, and keeps the provenance (sourceUrl, verified) of each stakeholder fact in the committed source of truth.
 * @tacticalObjective Validates id, name, nullable url, type, activities, sourceUrl (empty string allowed) and verified; accepts scripts/ingest/organizations.seed.json rows unchanged.
 */
export const OrganizationSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  url: HttpUrlSchema.nullable(),
  type: OrganizationTypeSchema,
  activities: z.array(ActivitySchema),
  // Blank means "no source found"; never invented. verified:false is the signal that a row is unconfirmed.
  sourceUrl: z.union([z.literal(''), HttpUrlSchema]),
  verified: z.boolean(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

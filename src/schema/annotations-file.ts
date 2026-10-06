import { z } from 'zod';
import { AnnotationSchema } from './annotation';
import { OrganizationSchema } from './organization';
import { GeneratedFromSchema } from './replay';

/**
 * @displayName Annotations file
 * @strategicPurpose The committed, human-editable source of truth for annotations and organizations.
 * @tacticalObjective Validates version, generatedFrom, organizations and annotations, and rejects duplicate organization ids, duplicate areaId values and stakeholder orgIds that resolve to no organization. generatedFrom describes the generator's run only; after a human edit the file is a primary-source input, the record is not re-stamped, and consumers must not compare the sidecar outputHash to the edited bytes.
 */
export const AnnotationsFileSchema = z
  .strictObject({
    version: z.literal(1),
    generatedFrom: GeneratedFromSchema,
    organizations: z.array(OrganizationSchema).min(1),
    annotations: z.array(AnnotationSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const orgIds = new Set<string>();
    file.organizations.forEach((org, index) => {
      if (orgIds.has(org.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['organizations', index, 'id'],
          message: `duplicate organization id ${org.id}`,
        });
      }
      orgIds.add(org.id);
    });
    const areaIds = new Set<string>();
    file.annotations.forEach((annotation, index) => {
      if (areaIds.has(annotation.areaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['annotations', index, 'areaId'],
          message: `duplicate areaId ${annotation.areaId}`,
        });
      }
      areaIds.add(annotation.areaId);
      annotation.stakeholders.forEach((link, linkIndex) => {
        if (!orgIds.has(link.orgId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['annotations', index, 'stakeholders', linkIndex, 'orgId'],
            message: `orgId ${link.orgId} matches no organization`,
          });
        }
      });
    });
  });
export type AnnotationsFile = z.infer<typeof AnnotationsFileSchema>;

/**
 * @displayName Annotations file checked against areas
 * @strategicPurpose Closes the cross-file seam: every annotation areaId must exist in data/areas.geojson, which this schema cannot see on its own.
 * @tacticalObjective Returns AnnotationsFileSchema plus an unknown-areaId check against the given set of properties.id values from a parsed AreaFeatureCollectionSchema.
 */
export function annotationsFileForAreas(areaIds: ReadonlySet<string>) {
  return AnnotationsFileSchema.superRefine((file, ctx) => {
    file.annotations.forEach((annotation, index) => {
      if (!areaIds.has(annotation.areaId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['annotations', index, 'areaId'],
          message: `areaId ${annotation.areaId} is not in areas.geojson`,
        });
      }
    });
  });
}

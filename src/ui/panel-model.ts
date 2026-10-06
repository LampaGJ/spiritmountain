import type { Area } from '../schema/area';
import type { Annotation } from '../schema/annotation';
import type { Organization } from '../schema/organization';

/**
 * @displayName Annotation source
 * @strategicPurpose Keeps "annotations failed to load" distinct from "this area has no annotation", so a broken load never reads as a correct empty result.
 * @tacticalObjective Either the parsed maps from load-annotations.ts or the load error message.
 */
export type AnnotationSource =
  | {
      readonly status: 'loaded';
      readonly annotations: ReadonlyMap<string, Annotation>;
      readonly organizations: ReadonlyMap<string, Organization>;
    }
  | { readonly status: 'failed'; readonly message: string };

/**
 * @displayName Panel view model
 * @strategicPurpose The only thing panel.ts renders; pure data so it can be tested without a DOM.
 * @tacticalObjective One of three states (annotated, no-annotation, failed) with title, kind, id, difficulty and, when annotated, activities, stakeholders and notes.
 */
export type PanelModel =
  | (PanelCommon & {
      readonly state: 'annotated';
      readonly activities: readonly {
        activity: string;
        seasons: readonly string[];
        notes: string;
      }[];
      readonly stakeholders: readonly { orgName: string; role: string }[];
      readonly notes: string;
    })
  | (PanelCommon & { readonly state: 'no-annotation' })
  | (PanelCommon & { readonly state: 'failed'; readonly errorMessage: string });

interface PanelCommon {
  readonly areaId: string;
  readonly title: string;
  readonly kind: string;
  /** Verbatim OSM difficulty, or null when OSM has none (rendered as "not recorded"). */
  readonly difficulty: string | null;
}

/** Shown wherever a value is blank. Facts are never invented, so blank stays visible. */
export const NOT_RECORDED = 'not recorded';

/**
 * @displayName Area title
 * @strategicPurpose One rule for naming an area in the tooltip and the panel; never invents a name.
 * @tacticalObjective Returns the OSM name, or "<id> (<kind>)" when the name is null.
 */
export function areaTitle(area: Pick<Area, 'id' | 'kind' | 'name'>): string {
  return area.name ?? `${area.id} (${area.kind})`;
}

/**
 * @displayName Build panel model
 * @strategicPurpose Turns an area plus the annotation source into the single structure the panel renders.
 * @tacticalObjective Returns state annotated, no-annotation or failed; resolves org ids to names. Every orgId resolves because parseAnnotations rejects a dangling one (the tolerant "unknown organisation" path was removed).
 */
export function buildPanelModel(area: Area, source: AnnotationSource): PanelModel {
  const common: PanelCommon = {
    areaId: area.id,
    title: areaTitle(area),
    kind: area.kind,
    difficulty: area.difficulty,
  };
  if (source.status === 'failed') {
    return { ...common, state: 'failed', errorMessage: source.message };
  }
  const annotation = source.annotations.get(area.id);
  if (annotation === undefined) {
    return { ...common, state: 'no-annotation' };
  }
  return {
    ...common,
    state: 'annotated',
    activities: annotation.activities.map((entry) => ({
      activity: entry.activity,
      seasons: entry.seasons,
      notes: entry.notes,
    })),
    stakeholders: annotation.stakeholders.map((link) => {
      const organization = source.organizations.get(link.orgId);
      if (organization === undefined) {
        // Invariant, not a tolerated state: annotationsFileForAreas rejects a dangling orgId before a loaded source exists.
        throw new Error(`stakeholder orgId ${link.orgId} has no organization`);
      }
      return { orgName: organization.name, role: link.role };
    }),
    notes: annotation.notes,
  };
}

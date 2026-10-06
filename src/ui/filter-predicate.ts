import type { z } from 'zod';
import type { Area } from '../schema/area';
import type { ActivitySchema, Annotation, SeasonSchema } from '../schema/annotation';

export type Activity = z.infer<typeof ActivitySchema>;
export type Season = z.infer<typeof SeasonSchema>;

export interface Filter {
  readonly activities: ReadonlySet<Activity>;
  readonly seasons: ReadonlySet<Season>;
}

export const EMPTY_FILTER: Filter = { activities: new Set(), seasons: new Set() };

export function isFilterActive(filter: Filter): boolean {
  return filter.activities.size > 0 || filter.seasons.size > 0;
}

/**
 * Decides whether one area is visible under a filter.
 *
 * Rules: no active filter shows everything; lifts are always visible (terrain and lifts
 * remain visible, spec:332-333); otherwise at least ONE annotation entry must satisfy the
 * activity condition and the season condition together (per-entry, not per-set union).
 *
 * Unannotated areas (annotation undefined) and annotations with an empty activities list
 * are HIDDEN while any filter is active and visible otherwise. This is a recorded decision:
 * showing unclassified areas as if they matched would mislead a reviewer. It is reversible
 * in the single `return false` below.
 *
 * An entry with seasons [] never matches an active season filter but matches an
 * activity-only filter.
 */
export function matchesFilter(
  area: Area,
  annotation: Annotation | undefined,
  filter: Filter,
): boolean {
  if (!isFilterActive(filter)) return true;
  if (area.kind === 'lift') return true;
  if (annotation === undefined) return false;
  return annotation.activities.some(
    (entry) =>
      (filter.activities.size === 0 || filter.activities.has(entry.activity)) &&
      (filter.seasons.size === 0 || entry.seasons.some((s) => filter.seasons.has(s))),
  );
}

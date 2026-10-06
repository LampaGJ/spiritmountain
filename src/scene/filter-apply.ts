import type { Annotation } from '../schema/annotation';
import { matchesFilter, type Filter } from '../ui/filter-predicate';
import type { AreaEntry } from './areas';

export interface FilterResult {
  readonly visibleIds: ReadonlySet<string>;
  /** N: visible areas, lifts included. */
  readonly visibleCount: number;
  /** M: every area in the registry. */
  readonly total: number;
}

/**
 * Sets `.visible` on every Line2 in each entry's `lines` from the predicate; all rings of an area share one
 * visibility. Terrain is never touched. #13's pickArea skips `visible === false` objects, so no pick list is kept here.
 */
export function applyFilter(
  registry: ReadonlyMap<string, AreaEntry>,
  annotations: ReadonlyMap<string, Annotation>,
  filter: Filter,
): FilterResult {
  const visibleIds = new Set<string>();
  for (const [id, { area, lines }] of registry) {
    const visible = matchesFilter(area, annotations.get(area.id), filter);
    for (const line of lines) line.visible = visible;
    if (visible) visibleIds.add(id);
  }
  return { visibleIds, visibleCount: visibleIds.size, total: registry.size };
}

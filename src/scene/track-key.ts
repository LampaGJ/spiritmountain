/**
 * The one definition of "same track" (#49, #50). OSM splits one trail into many ways, so the sign layer and the filter
 * counts both group areas by this key; keeping it here means the two can never drift. Pure (no three import).
 */
import type { Area } from '../schema/area';

/** The slice of an Area the key reads. */
export type TrackKeyInput = Pick<Area, 'id' | 'kind' | 'name' | 'osmTags'>;

/** The display name of a track, or null when OSM names it nowhere: `name`, else `route:name`. */
export function trackName(area: Pick<Area, 'name' | 'osmTags'>): string | null {
  return area.name ?? area.osmTags['route:name'] ?? null;
}

/** `kind + (name ?? osmTags["route:name"] ?? id)`. An unnamed segment is its own track, keyed by its id. */
export function trackKey(area: TrackKeyInput): string {
  return `${area.kind}:${trackName(area) ?? area.id}`;
}

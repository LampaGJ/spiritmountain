import type { z } from 'zod';
import type { Area } from '../schema/area';
import { ActivitySchema, SeasonSchema, type Annotation } from '../schema/annotation';
import { trackKey } from '../scene/track-key';

/** Distinct tracks among areas (#50): OSM splits one trail into many ways, so counts use the same key as the signs. */
const countTracks = (areas: readonly Area[]): number => new Set(areas.map(trackKey)).size;

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
 * Rules: lifts are always visible (terrain and lifts remain visible, spec:332-333); with no
 * active filter every other area is hidden (#72: the default view shows no trails); otherwise at least ONE annotation entry must satisfy the
 * activity condition and the season condition together (per-entry, not per-set union).
 *
 * Unannotated areas (annotation undefined) and annotations with an empty activities list
 * are HIDDEN, filtered or not (#72). This is a recorded decision: showing unclassified areas
 * as if they matched would mislead a reviewer.
 *
 * An entry with seasons [] never matches an active season filter but matches an
 * activity-only filter.
 */
export function matchesFilter(
  area: Area,
  annotation: Annotation | undefined,
  filter: Filter,
): boolean {
  if (area.kind === 'lift') return true;
  if (!isFilterActive(filter)) return false;
  if (annotation === undefined) return false;
  return annotation.activities.some(
    (entry) =>
      (filter.activities.size === 0 || filter.activities.has(entry.activity)) &&
      (filter.seasons.size === 0 || entry.seasons.some((s) => filter.seasons.has(s))),
  );
}

/** Match counts per option, excluding always-visible lifts, so the strip can show "N" on each button and disable zero-match options. */
export interface FacetCounts {
  readonly activities: ReadonlyMap<Activity, number>;
  readonly seasons: ReadonlyMap<Season, number>;
  /** Distinct tracks (lifts excluded) matching the current filter. */
  readonly matching: number;
  /** Areas that are lifts and therefore always shown. */
  readonly lifts: number;
  /** Distinct non-lift tracks in total. */
  readonly candidates: number;
}

/**
 * The activities each season offers: an activity belongs to a season when any annotation entry lists it with that
 * season. Every season is a key (a season with no entries maps to []); lists follow ActivitySchema.options order;
 * lift-ride is excluded because lifts are always visible. Derived from the already-parsed annotations map.
 */
export function seasonActivities(
  annotations: ReadonlyMap<string, Annotation>,
): ReadonlyMap<Season, readonly Activity[]> {
  const found = new Map<Season, Set<Activity>>(SeasonSchema.options.map((s) => [s, new Set()]));
  for (const annotation of annotations.values()) {
    for (const e of annotation.activities) {
      if (e.activity === 'lift-ride') continue;
      for (const season of e.seasons) found.get(season)?.add(e.activity);
    }
  }
  return new Map(
    SeasonSchema.options.map((season) => {
      const set = found.get(season) ?? new Set<Activity>();
      return [season, ActivitySchema.options.filter((a) => set.has(a))] as const;
    }),
  );
}

/** Per-season and per-activity-in-season counts for the season menu; lifts excluded. */
export interface SeasonCounts {
  /** Distinct non-lift tracks with at least one entry in that season. */
  readonly seasons: ReadonlyMap<Season, number>;
  /** Distinct non-lift tracks with an entry listing that activity with that season. Only activities the season offers are keys. */
  readonly activities: ReadonlyMap<Season, ReadonlyMap<Activity, number>>;
}

/** Counts for the season bar badges and the rail's season-mode Activity badges. Pure and deterministic. */
export function seasonCounts(
  areas: readonly Area[],
  annotations: ReadonlyMap<string, Annotation>,
): SeasonCounts {
  // Track keys seen per season and per activity in a season, so a split track counts once.
  const seasonTracks = new Map<Season, Set<string>>(
    SeasonSchema.options.map((s) => [s, new Set()]),
  );
  const activityTracks = new Map<Season, Map<Activity, Set<string>>>(
    SeasonSchema.options.map((s) => [s, new Map()]),
  );
  for (const area of areas) {
    if (area.kind === 'lift') continue;
    const annotation = annotations.get(area.id);
    if (annotation === undefined) continue;
    const key = trackKey(area);
    for (const season of SeasonSchema.options) {
      const here = annotation.activities.filter(
        (e) => e.activity !== 'lift-ride' && e.seasons.includes(season),
      );
      if (here.length === 0) continue;
      seasonTracks.get(season)?.add(key);
      const perActivity = activityTracks.get(season);
      if (perActivity === undefined) continue;
      for (const act of new Set(here.map((e) => e.activity))) {
        const keys = perActivity.get(act);
        if (keys) keys.add(key);
        else perActivity.set(act, new Set([key]));
      }
    }
  }
  const seasons = new Map<Season, number>(
    SeasonSchema.options.map((s) => [s, seasonTracks.get(s)?.size ?? 0]),
  );
  const activities = new Map<Season, Map<Activity, number>>(
    SeasonSchema.options.map((s) => [
      s,
      new Map([...(activityTracks.get(s) ?? [])].map(([a, keys]) => [a, keys.size])),
    ]),
  );
  // Re-key each per-activity map in schema order so iteration never depends on annotation order.
  const ordered = new Map<Season, ReadonlyMap<Activity, number>>(
    SeasonSchema.options.map((s) => {
      const counts = activities.get(s) ?? new Map<Activity, number>();
      return [
        s,
        new Map(
          ActivitySchema.options.filter((a) => counts.has(a)).map((a) => [a, counts.get(a) ?? 0]),
        ),
      ] as const;
    }),
  );
  return { seasons, activities: ordered };
}

/**
 * For every option, the number of distinct non-lift tracks that would match if that option were
 * ADDED to the current filter (the standard faceted-navigation count). Options already
 * selected report their count under the current filter. Pure and deterministic.
 */
export function facetCounts(
  areas: readonly Area[],
  annotations: ReadonlyMap<string, Annotation>,
  filter: Filter,
  activityOptions: readonly Activity[],
  seasonOptions: readonly Season[],
): FacetCounts {
  const nonLift = areas.filter((a) => a.kind !== 'lift');
  const count = (f: Filter): number =>
    countTracks(nonLift.filter((a) => matchesFilter(a, annotations.get(a.id), f)));
  const withActivity = (act: Activity): Filter => ({
    activities: new Set([...filter.activities, act]),
    seasons: filter.seasons,
  });
  const withSeason = (season: Season): Filter => ({
    activities: filter.activities,
    seasons: new Set([...filter.seasons, season]),
  });
  const activities = new Map<Activity, number>();
  for (const act of activityOptions) activities.set(act, count(withActivity(act)));
  const seasons = new Map<Season, number>();
  for (const season of seasonOptions) seasons.set(season, count(withSeason(season)));
  return {
    activities,
    seasons,
    matching: count(filter),
    lifts: areas.length - nonLift.length,
    candidates: countTracks(nonLift),
  };
}

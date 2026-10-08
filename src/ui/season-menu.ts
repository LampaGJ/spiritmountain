import './season-menu.css';
import { SPORT_COLOR } from '../scene/palette';
import { ActivitySchema, SeasonSchema } from '../schema/annotation';
import { createToggleKey, type ClickyKey } from './clicky-key';
import { HashFilterSchema, type HashFilter } from './filter-hash';
import type { Activity, Season, SeasonCounts } from './filter-predicate';
import { NO_MATCH_TITLE } from './filters';
import { iconFor } from './icons';
import { getTopBar, releaseTopBar } from './top-bar';

/**
 * @displayName Season menu
 * @strategicPurpose Lets a reviewer pick one season along the top of the page and see only that season's activities, then switch them off one by one or drop the season to return to the default view.
 * @tacticalObjective Pure transitions on the hash state (select a season, toggle an activity within it, normalise a pasted hash) shared by the top bar, its activity row and the rail; plus the bar and row DOM, built with createElement only.
 */

/** Activities per season, from seasonActivities in filter-predicate.ts. Every season is a key; an empty list means the season is unavailable. */
export type SeasonMap = ReadonlyMap<Season, readonly Activity[]>;

const listOf = (map: SeasonMap, season: Season): readonly Activity[] => map.get(season) ?? [];

/** Activities in schema order, so the written hash is canonical regardless of click order. */
const ordered = (values: Iterable<Activity>): Activity[] => {
  const set = new Set(values);
  return ActivitySchema.options.filter((a) => set.has(a));
};

/** activity and season emptied; imagery, buildings, surface, trees and exag kept. */
const cleared = (state: HashFilter): HashFilter =>
  HashFilterSchema.parse({ ...state, activity: [], season: [] });

/**
 * Pressing the active season clears both keys; pressing another season selects it with its full activity list (switching
 * replaces the list). A season with no activities is a no-op and returns the same object.
 */
export function selectSeason(state: HashFilter, season: Season, map: SeasonMap): HashFilter {
  if (state.season.length === 1 && state.season[0] === season) return cleared(state);
  const list = listOf(map, season);
  if (list.length === 0) return state;
  return HashFilterSchema.parse({ ...state, season: [season], activity: [...list] });
}

/**
 * Switches one activity off or back on within the active season. Removing the last one clears both keys, because an empty
 * activity list with a season set means the whole season (filter-predicate.ts matchesFilter). An activity the season does
 * not offer is a no-op. With no season active it is a plain set toggle.
 */
export function toggleSeasonActivity(
  state: HashFilter,
  activity: Activity,
  map: SeasonMap,
): HashFilter {
  const season = state.season[0];
  const current = new Set(state.activity);
  if (current.has(activity)) current.delete(activity);
  else current.add(activity);
  if (season === undefined) return HashFilterSchema.parse({ ...state, activity: ordered(current) });
  const list = listOf(map, season);
  if (!list.includes(activity)) return state;
  const next = ordered(current).filter((a) => list.includes(a));
  if (next.length === 0) return cleared(state);
  return HashFilterSchema.parse({ ...state, activity: next });
}

/**
 * Makes any decoded hash a state the single-select bar can show. Keeps the first season (schema order) that offers
 * activities and drops the rest; intersects activity with that season's list, expanding an empty result to the full list.
 * With no usable season, activity is untouched (`#activity=hike` alone stays legal). Idempotent; returns the same object
 * when nothing changes.
 */
export function normalizeSeason(state: HashFilter, map: SeasonMap): HashFilter {
  if (state.season.length === 0) return state;
  const season = SeasonSchema.options.find(
    (s) => state.season.includes(s) && listOf(map, s).length > 0,
  );
  if (season === undefined) return HashFilterSchema.parse({ ...state, season: [] });
  const list = listOf(map, season);
  const kept = state.activity.filter((a) => list.includes(a));
  const activity = kept.length === 0 ? [...list] : ordered(kept);
  const same =
    state.season.length === 1 &&
    activity.length === state.activity.length &&
    activity.every((a, i) => state.activity[i] === a);
  if (same) return state;
  return HashFilterSchema.parse({ ...state, season: [season], activity });
}

export interface SeasonBarDeps {
  readonly map: SeasonMap;
  readonly counts: SeasonCounts;
  /** A season key was pressed (never called for a disabled season). */
  readonly onSeason: (season: Season) => void;
  /** An activity key in the open row was pressed. */
  readonly onActivity: (activity: Activity) => void;
}

export interface SeasonBar {
  /** The shared `nav#season-bar` (top-bar.ts), already in document.body. */
  readonly root: HTMLElement;
  /** Shows the state: pressed season, data-open, the row's keys and their pressed state. */
  render(state: HashFilter): void;
  /** Removes the season keys and the activity row; the bar goes too once no popout is left in it. */
  dispose(): void;
}

/** The row's id, referenced by the active season key's aria-controls. */
export const SEASON_ROW_ID = 'season-bar-activities';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

/**
 * Builds the top season bar: four season toggle keys in one group, then the activity row (a named group, hidden while no
 * season is active). Single-select: the caller turns presses into selectSeason / toggleSeasonActivity. Escape inside the
 * row moves focus to the active season key and changes nothing else.
 */
export function buildSeasonBar(deps: SeasonBarDeps): SeasonBar {
  const { root, keys } = getTopBar();

  const seasonRow = document.createElement('div');
  seasonRow.className = 'sm-season-keys';
  seasonRow.setAttribute('role', 'group');
  seasonRow.setAttribute('aria-label', 'Seasons');

  const row = document.createElement('div');
  row.className = 'sm-season-row';
  row.id = SEASON_ROW_ID;
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Season activities');
  row.hidden = true;

  const seasonKeys = new Map<Season, ClickyKey>();
  for (const season of SeasonSchema.options) {
    const { symbol, label } = iconFor(season);
    const key = createToggleKey(label, { icon: symbol });
    key.button.setAttribute('aria-expanded', 'false');
    key.setCount(deps.counts.seasons.get(season) ?? 0);
    if ((deps.map.get(season) ?? []).length === 0) {
      key.root.classList.add('is-zero');
      key.button.setAttribute('aria-disabled', 'true');
      key.button.title = NO_MATCH_TITLE;
    }
    key.button.addEventListener('click', () => {
      // aria-disabled keys stay focusable but do nothing (the filters.ts toggle guard).
      if (key.button.getAttribute('aria-disabled') === 'true') return;
      deps.onSeason(season);
    });
    seasonRow.appendChild(key.root);
    seasonKeys.set(season, key);
  }

  let rowSeason: Season | undefined;
  const activityKeys = new Map<Activity, ClickyKey>();
  const buildRow = (season: Season | undefined): void => {
    if (season === rowSeason) return;
    rowSeason = season;
    activityKeys.clear();
    const keys: HTMLElement[] = [];
    if (season !== undefined) {
      const counts = deps.counts.activities.get(season);
      for (const activity of deps.map.get(season) ?? []) {
        const { symbol, label } = iconFor(activity);
        const key = createToggleKey(label, { icon: symbol });
        // The sport colour the lines take (#40 SPORT_COLOR), as a small aria-hidden swatch.
        const swatch = document.createElement('span');
        swatch.className = 'sm-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.setProperty('--sm-swatch', hex(SPORT_COLOR[activity]));
        key.button.querySelector('.btn-face')?.prepend(swatch);
        key.setCount(counts?.get(activity) ?? 0);
        key.button.addEventListener('click', () => deps.onActivity(activity));
        activityKeys.set(activity, key);
        keys.push(key.root);
      }
    }
    row.replaceChildren(...keys);
  };

  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || rowSeason === undefined) return;
    event.preventDefault();
    seasonKeys.get(rowSeason)?.button.focus();
  });

  // One season group per bar: a second build replaces the first.
  root.querySelectorAll('.sm-season-keys, .sm-season-row').forEach((old) => old.remove());
  keys.append(seasonRow);
  root.append(row);

  const render = (state: HashFilter): void => {
    const active = state.season.length === 1 ? state.season[0] : undefined;
    buildRow(active);
    for (const [season, key] of seasonKeys) {
      const on = season === active;
      key.button.setAttribute('aria-pressed', String(on));
      key.button.setAttribute('aria-expanded', String(on));
      if (on) key.button.setAttribute('aria-controls', SEASON_ROW_ID);
      else key.button.removeAttribute('aria-controls');
    }
    for (const [activity, key] of activityKeys) {
      key.button.setAttribute('aria-pressed', String(state.activity.includes(activity)));
    }
    row.hidden = active === undefined;
    root.toggleAttribute('data-open', active !== undefined);
  };

  const dispose = (): void => {
    seasonRow.remove();
    row.remove();
    root.removeAttribute('data-open');
    releaseTopBar();
  };

  return { root, render, dispose };
}

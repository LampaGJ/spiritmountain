import { ActivitySchema } from '../schema/annotation';
import {
  HashFilterSchema,
  decodeHash,
  encodeHash,
  ignoredNotice,
  toFilter,
  type HashFilter,
} from './filter-hash';
import { createClickKey, createToggleKey, type ClickyKey } from './clicky-key';
import { createExaggerationKey, type ExaggerationKey } from './exaggeration-key';
import { iconFor } from './icons';
import { groupHead } from './rail';
import type { Activity, FacetCounts, Filter, SeasonCounts } from './filter-predicate';
import {
  buildSeasonBar,
  normalizeSeason,
  selectSeason,
  toggleSeasonActivity,
  type SeasonBar,
  type SeasonMap,
} from './season-menu';

export interface StripCounts {
  visibleCount: number;
  total: number;
  /** Per-option match counts. When present the strip shows a badge on every key and disables zero-match options. */
  facets?: FacetCounts;
}

/** Title on an option that has no matching areas. */
export const NO_MATCH_TITLE = 'no areas annotated for this yet';

export interface FilterStripDeps {
  readonly host: HTMLElement;
  readonly apply: (filter: Filter) => StripCounts;
  readonly readHash: () => string;
  readonly writeHash: (hash: string) => void;
  /** Called with the imagery switch on mount and whenever it changes. Absent means no Imagery button. */
  readonly setImagery?: (on: boolean) => void;
  /** Called with the buildings switch on mount and whenever it changes. Absent means no Buildings button. */
  readonly setBuildings?: (on: boolean) => void;
  /** Called with the surface switch on mount and whenever it changes. Absent means no Surface button. */
  readonly setSurface?: (on: boolean) => void;
  /** Called with the trees switch on mount and whenever it changes. Absent means no Trees button. */
  readonly setTrees?: (on: boolean) => void;
  /** Called with the terrain exaggeration factor (0 to 10, 1 = true scale) on mount and whenever it changes. Absent means no slider. */
  readonly setExaggeration?: (k: number) => void;
  /** Activities per season (seasonActivities). With seasonCounts, mounts the top season bar and normalises the hash. */
  readonly seasonMap?: SeasonMap;
  /** Per-season and per-activity-in-season counts (seasonCounts) for the bar badges and the rail in season mode. */
  readonly seasonCounts?: SeasonCounts;
}

export interface FilterStrip {
  sync(): void;
  dispose(): void;
}

/** replaceState adds no history entry and does not scroll, unlike location.hash assignment. */
export const browserHash = {
  readHash: (): string => location.hash,
  writeHash: (hash: string): void => {
    history.replaceState(null, '', location.pathname + location.search + hash);
  },
};

/** lift-ride is excluded: lifts are always visible, so that toggle would be a silent no-op. */
export const TOGGLE_ACTIVITIES = ActivitySchema.options.filter((a) => a !== 'lift-ride');

type Key = 'activity' | 'season';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

export function mountFilterStrip(deps: FilterStripDeps): FilterStrip {
  const buttons: { key: Key; value: string; handle: ClickyKey }[] = [];
  let state: HashFilter = { activity: [], season: [] };
  let imageryButton: HTMLButtonElement | undefined;
  let imageryApplied: boolean | undefined;
  let buildingsButton: HTMLButtonElement | undefined;
  let buildingsApplied: boolean | undefined;
  let surfaceButton: HTMLButtonElement | undefined;
  let surfaceApplied: boolean | undefined;
  let treesButton: HTMLButtonElement | undefined;
  let treesApplied: boolean | undefined;
  let exagKey: ExaggerationKey | undefined;
  let exagApplied: number | undefined;
  let seasonBar: SeasonBar | undefined;

  const count = el('p', undefined, 'filter-count');
  count.setAttribute('role', 'status');
  const notice = el('p', undefined, 'filter-notice');
  notice.setAttribute('role', 'status');

  const render = (): void => {
    const counts = deps.apply(toFilter(state));
    const { facets } = counts;
    // Season mode: one season active and the bar mounted. facetCounts would give every activity the same union count.
    const season = seasonBar === undefined ? undefined : state.season[0];
    const inSeason = season === undefined ? undefined : (deps.seasonMap?.get(season) ?? []);
    const seasonActivityCounts =
      season === undefined ? undefined : deps.seasonCounts?.activities.get(season);
    seasonBar?.render(state);
    for (const b of buttons) {
      const pressed = (state[b.key] as string[]).includes(b.value);
      // The pressed look (sunk key, accent face, check mark) is generated CSS keyed on aria-pressed.
      b.handle.button.setAttribute('aria-pressed', String(pressed));
      const offSeason =
        b.key === 'activity' && inSeason !== undefined && !inSeason.includes(b.value as Activity);
      b.handle.root.classList.toggle('is-off-season', offSeason);
      if (b.key === 'activity' && seasonActivityCounts !== undefined) {
        const n = seasonActivityCounts.get(b.value as Activity) ?? 0;
        b.handle.setCount(n);
        b.handle.root.classList.remove('is-zero');
        b.handle.button.removeAttribute('aria-disabled');
        b.handle.button.removeAttribute('title');
        continue;
      }
      if (facets === undefined) continue;
      const lookup: ReadonlyMap<string, number> =
        b.key === 'activity' ? facets.activities : facets.seasons;
      const n = lookup.get(b.value) ?? 0;
      b.handle.setCount(n);
      // A latched option stays operable so it can always be switched off.
      const empty = n === 0 && !pressed;
      b.handle.root.classList.toggle('is-zero', empty);
      if (empty) {
        b.handle.button.setAttribute('aria-disabled', 'true');
        b.handle.button.title = NO_MATCH_TITLE;
      } else {
        b.handle.button.removeAttribute('aria-disabled');
        b.handle.button.removeAttribute('title');
      }
    }
    if (facets === undefined) {
      count.textContent = `${counts.visibleCount} of ${counts.total} areas`;
    } else if (state.activity.length > 0 || state.season.length > 0) {
      count.textContent = `${facets.matching} of ${facets.candidates} areas match · ${facets.lifts} lifts always shown`;
    } else {
      count.textContent = `${facets.candidates} areas · ${facets.lifts} lifts`;
    }
    if (imageryButton) {
      const on = state.imagery !== false;
      imageryButton.setAttribute('aria-pressed', String(on));
      if (imageryApplied !== on) {
        imageryApplied = on;
        deps.setImagery?.(on);
      }
    }
    if (buildingsButton) {
      const on = state.buildings !== false;
      buildingsButton.setAttribute('aria-pressed', String(on));
      if (buildingsApplied !== on) {
        buildingsApplied = on;
        deps.setBuildings?.(on);
      }
    }
    if (surfaceButton) {
      const on = state.surface === true;
      surfaceButton.setAttribute('aria-pressed', String(on));
      if (surfaceApplied !== on) {
        surfaceApplied = on;
        deps.setSurface?.(on);
      }
    }
    if (treesButton) {
      const on = state.trees === true;
      treesButton.setAttribute('aria-pressed', String(on));
      if (treesApplied !== on) {
        treesApplied = on;
        deps.setTrees?.(on);
      }
    }
    if (exagKey) {
      const k = state.exag ?? 1;
      exagKey.setValue(k);
      if (exagApplied !== k) {
        exagApplied = k;
        deps.setExaggeration?.(k);
      }
    }
  };

  const writeIfChanged = (): void => {
    const next = encodeHash(state);
    if (next !== deps.readHash()) deps.writeHash(next);
  };

  /** The one write path for a new state: clear the notice, write the hash if it changed, re-render. */
  const commit = (next: HashFilter): void => {
    state = next;
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const toggle = (key: Key, value: string): void => {
    // aria-disabled keys stay focusable but do nothing; a latched key is never disabled, so it can always be switched off.
    const entry = buttons.find((b) => b.key === key && b.value === value);
    if (entry?.handle.button.getAttribute('aria-disabled') === 'true') return;
    // Season mode: the rail's Activity keys take the same transition as the bar's row, so an empty list clears both keys.
    if (key === 'activity' && deps.seasonMap !== undefined && state.season.length > 0) {
      commit(toggleSeasonActivity(state, value as Activity, deps.seasonMap));
      return;
    }
    const values = new Set<string>(state[key]);
    if (values.has(value)) values.delete(value);
    else values.add(value);
    commit(HashFilterSchema.parse({ ...state, [key]: [...values] }));
  };

  const toggleImagery = (): void => {
    state = HashFilterSchema.parse({ ...state, imagery: state.imagery === false });
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const toggleBuildings = (): void => {
    state = HashFilterSchema.parse({ ...state, buildings: state.buildings === false });
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const toggleSurface = (): void => {
    state = HashFilterSchema.parse({
      ...state,
      surface: state.surface === true ? undefined : true,
    });
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const toggleTrees = (): void => {
    state = HashFilterSchema.parse({
      ...state,
      trees: state.trees === true ? undefined : true,
    });
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const setExag = (k: number): void => {
    state = HashFilterSchema.parse({ ...state, exag: k === 1 ? undefined : k });
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  /** Clear resets the activity and season toggles only; the imagery, buildings, surface and trees switches and the exaggeration are layers, not filters. */
  const clear = (): void => {
    state = {
      activity: [],
      season: [],
      ...(state.imagery === false ? { imagery: false } : {}),
      ...(state.buildings === false ? { buildings: false } : {}),
      ...(state.surface === true ? { surface: true } : {}),
      ...(state.trees === true ? { trees: true } : {}),
      ...(state.exag === undefined ? {} : { exag: state.exag }),
    };
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const sync = (): void => {
    const decoded = decodeHash(deps.readHash());
    // normalizeSeason is idempotent and replaceState fires no hashchange, so this rewrite cannot loop.
    state =
      deps.seasonMap === undefined
        ? decoded.filter
        : normalizeSeason(decoded.filter, deps.seasonMap);
    notice.textContent = ignoredNotice(decoded.ignored) ?? '';
    writeIfChanged();
    render();
  };

  const section = (headIconId: string, slot?: string): HTMLDivElement => {
    const wrap = el('div', undefined, 'console-group');
    wrap.setAttribute('role', 'group');
    const headId = `console-head-${headIconId}`;
    wrap.setAttribute('aria-labelledby', headId);
    wrap.appendChild(groupHead(headIconId, headId));
    if (slot !== undefined) wrap.dataset.slot = slot;
    return wrap;
  };

  const group = (headIconId: string, key: Key, options: readonly string[]): HTMLDivElement => {
    const wrap = section(headIconId);
    const row = el('div', undefined, 'key-row');
    for (const value of options) {
      const { symbol, label } = iconFor(value);
      const handle = createToggleKey(label, { icon: symbol });
      handle.button.addEventListener('click', () => toggle(key, value));
      row.appendChild(handle.root);
      buttons.push({ key, value, handle });
    }
    wrap.appendChild(row);
    return wrap;
  };

  const clearEntry = iconFor('clear-filters');
  const clearKey = createClickKey(clearEntry.label, { icon: clearEntry.symbol });
  clearKey.button.addEventListener('click', clear);

  // Clear sits under the Activity group; the status line and the hash notice sit under Clear.
  const foot = el('div', undefined, 'console-foot');
  foot.append(clearKey.root, count, notice);

  // The Layers group is mounted only when the host supplies setImagery, setBuildings, setSurface or setTrees.
  const layersSlot = section('group-layers', 'imagery');
  const layerRow = el('div', undefined, 'key-row');
  layersSlot.append(layerRow);
  const layerKey = (id: string, onClick: () => void, pressed = true): HTMLButtonElement => {
    const { symbol, label } = iconFor(id);
    const key = createToggleKey(label, { icon: symbol });
    key.button.setAttribute('aria-pressed', String(pressed));
    key.button.addEventListener('click', onClick);
    layerRow.appendChild(key.root);
    return key.button;
  };
  if (deps.setImagery) imageryButton = layerKey('imagery', toggleImagery);
  if (deps.setBuildings) buildingsButton = layerKey('buildings', toggleBuildings);
  if (deps.setSurface) surfaceButton = layerKey('surface', toggleSurface, false);
  if (deps.setTrees) treesButton = layerKey('trees', toggleTrees, false);

  if (deps.setExaggeration) {
    const { symbol, label } = iconFor('terrain-exaggeration');
    exagKey = createExaggerationKey({ icon: symbol, label, onChange: setExag });
    layersSlot.append(exagKey.root);
  }

  // The season choice lives in the top bar (#42), not in the rail.
  const { seasonMap, seasonCounts } = deps;
  if (seasonMap !== undefined && seasonCounts !== undefined) {
    seasonBar = buildSeasonBar({
      map: seasonMap,
      counts: seasonCounts,
      onSeason: (season) => commit(selectSeason(state, season, seasonMap)),
      onActivity: (activity) => commit(toggleSeasonActivity(state, activity, seasonMap)),
    });
    document.body.appendChild(seasonBar.root);
  }

  deps.host.replaceChildren(
    group('group-activity', 'activity', TOGGLE_ACTIVITIES),
    foot,
    ...(deps.setImagery ||
    deps.setBuildings ||
    deps.setSurface ||
    deps.setTrees ||
    deps.setExaggeration
      ? [layersSlot]
      : []),
  );
  window.addEventListener('hashchange', sync);
  sync();

  return {
    sync,
    dispose: () => {
      window.removeEventListener('hashchange', sync);
      seasonBar?.root.remove();
    },
  };
}

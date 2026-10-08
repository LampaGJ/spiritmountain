import { ActivitySchema } from '../schema/annotation';
import {
  HashFilterSchema,
  decodeHash,
  encodeHash,
  ignoredNotice,
  toFilter,
  type HashFilter,
} from './filter-hash';
import { createClickKey, createToggleKey } from './clicky-key';
import { iconFor } from './icons';
import { createPopout, getTopBar, releaseTopBar, type Popout } from './top-bar';
import type { FacetCounts, Filter, SeasonCounts } from './filter-predicate';
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
  /** Called with the terrain exaggeration factor (0.1 to 10, 1 = true scale) on mount and whenever it changes. */
  readonly setExaggeration?: (k: number) => void;
  /** Called with the exaggeration the hash holds on mount and whenever it changes, so the DEBUG slider can show it (#58). */
  readonly showExaggeration?: (k: number) => void;
  /** Activities per season (seasonActivities). With seasonCounts, mounts the top season bar and normalises the hash. */
  readonly seasonMap?: SeasonMap;
  /** Per-season and per-activity-in-season counts (seasonCounts) for the bar badges and the rail in season mode. */
  readonly seasonCounts?: SeasonCounts;
}

export interface FilterStrip {
  sync(): void;
  /** The DEBUG slider's setter: writes `exag=` (nothing for 1) and applies it, exactly as the rail slider did. */
  setExaggeration(k: number): void;
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
  let state: HashFilter = { activity: [], season: [] };
  let imageryButton: HTMLButtonElement | undefined;
  let imageryApplied: boolean | undefined;
  let buildingsButton: HTMLButtonElement | undefined;
  let buildingsApplied: boolean | undefined;
  let surfaceButton: HTMLButtonElement | undefined;
  let surfaceApplied: boolean | undefined;
  let treesButton: HTMLButtonElement | undefined;
  let treesApplied: boolean | undefined;
  let layersPopout: Popout | undefined;
  let exagApplied: number | undefined;
  let seasonBar: SeasonBar | undefined;

  const count = el('p', undefined, 'filter-count');
  count.setAttribute('role', 'status');
  const notice = el('p', undefined, 'filter-notice');
  notice.setAttribute('role', 'status');

  const render = (): void => {
    const counts = deps.apply(toFilter(state));
    const { facets } = counts;
    seasonBar?.render(state);
    if (facets === undefined) {
      count.textContent = `${counts.visibleCount} of ${counts.total} areas`;
    } else if (state.activity.length > 0 || state.season.length > 0) {
      count.textContent = `${facets.matching} of ${facets.candidates} trails match · ${facets.lifts} lifts always shown`;
    } else {
      count.textContent = `Choose a season · ${facets.lifts} lifts`;
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
    if (deps.setExaggeration || deps.showExaggeration) {
      const k = state.exag ?? 1;
      deps.showExaggeration?.(k);
      if (exagApplied !== k) {
        exagApplied = k;
        deps.setExaggeration?.(k);
      }
    }
    // With the season bar mounted the status line lives there; the rail then holds only Clear Filters and the notice, and hides when neither applies (#58).
    if (seasonBar !== undefined) {
      deps.host.hidden =
        state.activity.length === 0 && state.season.length === 0 && notice.textContent === '';
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

  const clearEntry = iconFor('clear-filters');
  const clearKey = createClickKey(clearEntry.label, { icon: clearEntry.symbol });
  clearKey.button.addEventListener('click', clear);

  // Clear leads the rail (#56: activities live only in the season menu's row); the status line and the hash notice sit under Clear.
  const foot = el('div', undefined, 'console-foot');
  foot.append(clearKey.root, count, notice);

  // The Layers popout is mounted only when the host supplies setImagery, setBuildings, setSurface or setTrees.
  if (deps.setImagery || deps.setBuildings || deps.setSurface || deps.setTrees) {
    layersPopout = createPopout({
      iconId: 'group-layers',
      panelId: 'layers',
      panelLabel: 'Layers',
      align: 'end',
    });
  }
  const layerKey = (id: string, onClick: () => void, pressed = true): HTMLButtonElement => {
    const { symbol, label } = iconFor(id);
    const key = createToggleKey(label, { icon: symbol });
    key.button.setAttribute('aria-pressed', String(pressed));
    key.button.addEventListener('click', onClick);
    layersPopout?.panel.appendChild(key.root);
    return key.button;
  };
  if (deps.setImagery) imageryButton = layerKey('imagery', toggleImagery);
  if (deps.setBuildings) buildingsButton = layerKey('buildings', toggleBuildings);
  if (deps.setSurface) surfaceButton = layerKey('surface', toggleSurface, false);
  if (deps.setTrees) treesButton = layerKey('trees', toggleTrees, false);

  // The season choice lives in the top bar (#42), not in the rail.
  const { seasonMap, seasonCounts } = deps;
  if (seasonMap !== undefined && seasonCounts !== undefined) {
    seasonBar = buildSeasonBar({
      map: seasonMap,
      counts: seasonCounts,
      onSeason: (season) => commit(selectSeason(state, season, seasonMap)),
      onActivity: (activity) => commit(toggleSeasonActivity(state, activity, seasonMap)),
    });
    // The status line sits under the season keys (CSS order); the rail keeps Clear Filters and the notice.
    seasonBar.root.appendChild(count);
    foot.replaceChildren(clearKey.root, notice);
    if (layersPopout) getTopBar().keys.appendChild(layersPopout.root);
  } else if (layersPopout) {
    // No season bar (no season data): the Layers popout stays in the host.
    deps.host.appendChild(layersPopout.root);
  }

  deps.host.prepend(foot);
  window.addEventListener('hashchange', sync);
  sync();

  return {
    sync,
    setExaggeration: setExag,
    dispose: () => {
      window.removeEventListener('hashchange', sync);
      layersPopout?.dispose();
      seasonBar?.dispose();
      count.remove();
      releaseTopBar();
    },
  };
}

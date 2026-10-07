import { ActivitySchema, SeasonSchema } from '../schema/annotation';
import {
  HashFilterSchema,
  decodeHash,
  encodeHash,
  ignoredNotice,
  toFilter,
  type HashFilter,
} from './filter-hash';
import { createClickKey, createToggleKey, type ClickyKey } from './clicky-key';
import type { FacetCounts, Filter } from './filter-predicate';

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

  const count = el('p', undefined, 'filter-count');
  count.setAttribute('role', 'status');
  const notice = el('p', undefined, 'filter-notice');
  notice.setAttribute('role', 'status');

  const render = (): void => {
    const counts = deps.apply(toFilter(state));
    const { facets } = counts;
    for (const b of buttons) {
      const pressed = (state[b.key] as string[]).includes(b.value);
      // The pressed look (sunk key, accent face, check mark) is generated CSS keyed on aria-pressed.
      b.handle.button.setAttribute('aria-pressed', String(pressed));
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
  };

  const writeIfChanged = (): void => {
    const next = encodeHash(state);
    if (next !== deps.readHash()) deps.writeHash(next);
  };

  const toggle = (key: Key, value: string): void => {
    // aria-disabled keys stay focusable but do nothing; a latched key is never disabled, so it can always be switched off.
    const entry = buttons.find((b) => b.key === key && b.value === value);
    if (entry?.handle.button.getAttribute('aria-disabled') === 'true') return;
    const values = new Set<string>(state[key]);
    if (values.has(value)) values.delete(value);
    else values.add(value);
    state = HashFilterSchema.parse({ ...state, [key]: [...values] });
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

  /** Clear resets the activity and season toggles only; the imagery switch is a layer, not a filter. */
  const clear = (): void => {
    state = { activity: [], season: [], ...(state.imagery === false ? { imagery: false } : {}) };
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const sync = (): void => {
    const decoded = decodeHash(deps.readHash());
    state = decoded.filter;
    notice.textContent = ignoredNotice(decoded.ignored) ?? '';
    writeIfChanged();
    render();
  };

  const group = (label: string, key: Key, options: readonly string[]): HTMLFieldSetElement => {
    const fieldset = el('fieldset', undefined, 'console-group');
    fieldset.appendChild(el('legend', label));
    const row = el('div', undefined, 'key-row');
    for (const value of options) {
      const handle = createToggleKey(value);
      handle.button.addEventListener('click', () => toggle(key, value));
      row.appendChild(handle.root);
      buttons.push({ key, value, handle });
    }
    fieldset.appendChild(row);
    return fieldset;
  };

  const clearKey = createClickKey('Clear');
  clearKey.button.addEventListener('click', clear);

  const head = el('div', undefined, 'console-head');
  head.append(el('h2', 'Filter areas', 'console-title'), count, clearKey.root);

  // The Imagery fieldset is mounted only when the host supplies setImagery.
  const imagerySlot = el('fieldset', undefined, 'console-group console-slot');
  imagerySlot.dataset.slot = 'imagery';
  const imageryRow = el('div', undefined, 'key-row');
  imagerySlot.append(el('legend', 'Imagery'), imageryRow);
  if (deps.setImagery) {
    const imageryKey = createToggleKey('Imagery');
    imageryKey.button.setAttribute('aria-pressed', 'true');
    imageryKey.button.addEventListener('click', toggleImagery);
    imageryButton = imageryKey.button;
    imageryRow.appendChild(imageryKey.root);
  }

  deps.host.replaceChildren(
    head,
    group('Activity', 'activity', TOGGLE_ACTIVITIES),
    group('Season', 'season', SeasonSchema.options),
    ...(deps.setImagery ? [imagerySlot] : []),
    notice,
  );
  window.addEventListener('hashchange', sync);
  sync();

  return { sync, dispose: () => window.removeEventListener('hashchange', sync) };
}

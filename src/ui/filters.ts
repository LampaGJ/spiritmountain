import { ActivitySchema, SeasonSchema } from '../schema/annotation';
import {
  HashFilterSchema,
  decodeHash,
  encodeHash,
  ignoredNotice,
  toFilter,
  type HashFilter,
} from './filter-hash';
import type { Filter } from './filter-predicate';

export interface StripCounts {
  visibleCount: number;
  total: number;
}

export interface FilterStripDeps {
  readonly host: HTMLElement;
  readonly apply: (filter: Filter) => StripCounts;
  readonly readHash: () => string;
  readonly writeHash: (hash: string) => void;
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
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountFilterStrip(deps: FilterStripDeps): FilterStrip {
  const buttons: { key: Key; value: string; button: HTMLButtonElement }[] = [];
  let state: HashFilter = { activity: [], season: [] };

  const count = el('p');
  count.className = 'filter-count';
  count.setAttribute('role', 'status');
  const notice = el('p');
  notice.className = 'filter-notice';
  notice.setAttribute('role', 'status');

  const render = (): void => {
    for (const b of buttons) {
      const pressed = (state[b.key] as string[]).includes(b.value);
      b.button.setAttribute('aria-pressed', String(pressed));
      b.button.textContent = (pressed ? '✓ ' : '') + b.value;
    }
    const { visibleCount, total } = deps.apply(toFilter(state));
    count.textContent = `${visibleCount} of ${total} areas`;
  };

  const writeIfChanged = (): void => {
    const next = encodeHash(state);
    if (next !== deps.readHash()) deps.writeHash(next);
  };

  const toggle = (key: Key, value: string): void => {
    const values = new Set<string>(state[key]);
    if (values.has(value)) values.delete(value);
    else values.add(value);
    state = HashFilterSchema.parse({ ...state, [key]: [...values] });
    notice.textContent = '';
    writeIfChanged();
    render();
  };

  const clear = (): void => {
    state = { activity: [], season: [] };
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
    const fieldset = el('fieldset');
    fieldset.appendChild(el('legend', label));
    for (const value of options) {
      const button = el('button', value);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => toggle(key, value));
      fieldset.appendChild(button);
      buttons.push({ key, value, button });
    }
    return fieldset;
  };

  const clearButton = el('button', 'Clear');
  clearButton.type = 'button';
  clearButton.addEventListener('click', clear);

  deps.host.replaceChildren(
    group('Activity', 'activity', TOGGLE_ACTIVITIES),
    group('Season', 'season', SeasonSchema.options),
    clearButton,
    count,
    notice,
  );
  window.addEventListener('hashchange', sync);
  sync();

  return { sync, dispose: () => window.removeEventListener('hashchange', sync) };
}

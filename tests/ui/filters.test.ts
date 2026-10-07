// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Line2 } from 'three/addons/lines/Line2.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivitySchema, SeasonSchema } from '../../src/schema/annotation';
import type { FacetCounts } from '../../src/ui/filter-predicate';
import {
  mountFilterStrip,
  NO_MATCH_TITLE,
  TOGGLE_ACTIVITIES,
  type FilterStrip,
} from '../../src/ui/filters';
import { iconFor } from '../../src/ui/icons';
import { mountFilters } from '../../src/ui/mount-filters';
import { failedAnnotationsHandle, type AnnotationsHandle } from '../../src/wire-annotations';
import { makeArea } from './filter-fixtures';

const strips: FilterStrip[] = [];

afterEach(() => {
  for (const strip of strips.splice(0)) strip.dispose();
  document.body.replaceChildren();
  history.replaceState(null, '', location.pathname + location.search);
});

function setup(
  initialHash: string,
  withImagery = false,
  withBuildings = false,
  withSurface = false,
  withExag = false,
  withTrees = false,
) {
  const exagCalls: number[] = [];
  const surfaceCalls: boolean[] = [];
  const treesCalls: boolean[] = [];
  let hash = initialHash;
  const imageryCalls: boolean[] = [];
  const buildingsCalls: boolean[] = [];
  const writes: string[] = [];
  let applyCalls = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const strip = mountFilterStrip({
    host,
    apply: () => {
      applyCalls += 1;
      return { visibleCount: 3, total: 5 };
    },
    ...(withImagery ? { setImagery: (on: boolean) => void imageryCalls.push(on) } : {}),
    ...(withBuildings ? { setBuildings: (on: boolean) => void buildingsCalls.push(on) } : {}),
    ...(withSurface ? { setSurface: (on: boolean) => void surfaceCalls.push(on) } : {}),
    ...(withTrees ? { setTrees: (on: boolean) => void treesCalls.push(on) } : {}),
    ...(withExag ? { setExaggeration: (k: number) => void exagCalls.push(k) } : {}),
    readHash: () => hash,
    writeHash: (h) => {
      hash = h;
      writes.push(h);
    },
  });
  strips.push(strip);
  const button = (text: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(
      (b) => b.querySelector('.btn-label')?.textContent === text,
    );
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  };
  return {
    host,
    strip,
    button,
    writes,
    imageryCalls,
    buildingsCalls,
    surfaceCalls,
    treesCalls,
    exagCalls,
    getHash: () => hash,
    calls: () => applyCalls,
  };
}

describe('filter strip', () => {
  it('generates toggles from the schemas, shows title-case labels, and omits lift-ride', () => {
    const { host } = setup('');
    const labels = [...host.querySelectorAll('button .btn-label')].map((b) => b.textContent);
    expect(labels).not.toContain('Lift Ride');
    expect(labels).not.toContain('lift-ride');
    for (const id of TOGGLE_ACTIVITIES) expect(labels).toContain(iconFor(id).label);
    for (const season of SeasonSchema.options) expect(labels).toContain(iconFor(season).label);
    expect(TOGGLE_ACTIVITIES).toHaveLength(ActivitySchema.options.length - 1);
    // Kebab-case ids stay internal: none of them is ever a visible label.
    for (const id of ActivitySchema.options) expect(labels).not.toContain(id);
  });

  it('flips aria-pressed, writes the canonical hash and updates the count on click', () => {
    const { host, button, getHash } = setup('');
    button('Nordic Classic').click();
    expect(button('Nordic Classic').getAttribute('aria-pressed')).toBe('true');
    expect(getHash()).toBe('#activity=nordic-classic');
    expect(host.querySelector('.filter-count')?.textContent).toBe('3 of 5 areas');
    button('Nordic Classic').click();
    expect(button('Nordic Classic').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('');
  });

  it('shows the ignored notice for a bad hash and rewrites it canonically', () => {
    const { host, getHash } = setup('#activity=foo');
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: foo');
    expect(getHash()).toBe('');
  });

  it('does not write when the hash is already canonical', () => {
    const { writes, button } = setup('#season=winter');
    expect(writes).toHaveLength(0);
    expect(button('Winter').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores an unknown key, shows it in the notice, and rewrites the hash without it', () => {
    const { host, getHash } = setup('#season=winter&view=x');
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: view=x');
    expect(getHash()).toBe('#season=winter');
  });

  it('clears all toggles', () => {
    const { button, getHash } = setup('#activity=hike&season=winter');
    button('Clear Filters').click();
    expect(getHash()).toBe('');
    expect(button('Hike').getAttribute('aria-pressed')).toBe('false');
  });

  it('stops reacting to hashchange after dispose', () => {
    const { strip, calls } = setup('');
    strip.dispose();
    const before = calls();
    window.dispatchEvent(new Event('hashchange'));
    expect(calls()).toBe(before);
  });
});

describe('facet counts and the zero state', () => {
  // Only nordic-classic (40) and winter (12) have matches; everything else is zero.
  const facets = (matching: number): FacetCounts => ({
    activities: new Map(
      TOGGLE_ACTIVITIES.map((a) => [a, a === 'nordic-classic' ? 40 : 0] as const),
    ),
    seasons: new Map(SeasonSchema.options.map((s) => [s, s === 'winter' ? 12 : 0] as const)),
    matching,
    lifts: 8,
    candidates: 107,
  });

  const setupFacets = (initialHash: string, matching = 107) => {
    let hash = initialHash;
    const host = document.createElement('div');
    document.body.appendChild(host);
    strips.push(
      mountFilterStrip({
        host,
        apply: () => ({ visibleCount: 0, total: 115, facets: facets(matching) }),
        readHash: () => hash,
        writeHash: (h) => {
          hash = h;
        },
      }),
    );
    const key = (label: string): HTMLButtonElement => {
      const found = [...host.querySelectorAll('button')].find(
        (b) => b.querySelector('.btn-label')?.textContent === label,
      );
      if (found === undefined) throw new Error(`no key ${label}`);
      return found;
    };
    return { host, key, getHash: () => hash };
  };

  it('puts a count badge on every toggle', () => {
    const { key } = setupFacets('');
    expect(key('Nordic Classic').querySelector('.btn-count')?.textContent).toBe('40');
    expect(key('Winter').querySelector('.btn-count')?.textContent).toBe('12');
    expect(key('Spring').querySelector('.btn-count')?.textContent).toBe('0');
  });

  it('renders a zero-count option as aria-disabled with the explanatory title, still focusable', () => {
    const { key } = setupFacets('');
    for (const label of ['Hike', 'Tubing', 'Spring']) {
      const button = key(label);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.title).toBe(NO_MATCH_TITLE);
      expect(button.disabled).toBe(false);
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.closest('.cl-key')?.classList.contains('is-zero')).toBe(true);
    }
    expect(key('Nordic Classic').hasAttribute('aria-disabled')).toBe(false);
    expect(key('Nordic Classic').hasAttribute('title')).toBe(false);
  });

  it('ignores a click on a zero-count option and leaves the hash alone', () => {
    const { key, getHash } = setupFacets('');
    key('Spring').click();
    expect(key('Spring').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('');
  });

  it('keeps a latched zero-count option operable so it can be switched off', () => {
    const { key, getHash } = setupFacets('#season=spring', 0);
    expect(key('Spring').getAttribute('aria-pressed')).toBe('true');
    expect(key('Spring').hasAttribute('aria-disabled')).toBe(false);
    key('Spring').click();
    expect(key('Spring').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('');
  });

  it('words the status line for no filter and for an active filter', () => {
    const idle = setupFacets('');
    expect(idle.host.querySelector('.filter-count')?.textContent).toBe('107 areas · 8 lifts');
    const active = setupFacets('#activity=nordic-classic', 40);
    expect(active.host.querySelector('.filter-count')?.textContent).toBe(
      '40 of 107 areas match · 8 lifts always shown',
    );
  });
});

describe('imagery toggle', () => {
  it('has no Imagery button unless setImagery is wired', () => {
    const { host } = setup('');
    expect(host.textContent).not.toContain('Imagery');
  });

  it('defaults on: pressed, the hash stays empty, and setImagery(true) is called once', () => {
    const { button, getHash, imageryCalls } = setup('', true);
    expect(button('Imagery').getAttribute('aria-pressed')).toBe('true');
    expect(getHash()).toBe('');
    expect(imageryCalls).toEqual([true]);
  });

  it('toggling off writes imagery=off and calls setImagery(false); toggling on clears it', () => {
    const { button, getHash, imageryCalls } = setup('', true);
    button('Imagery').click();
    expect(button('Imagery').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('#imagery=off');
    button('Imagery').click();
    expect(getHash()).toBe('');
    expect(imageryCalls).toEqual([true, false, true]);
  });

  it('starts off from #imagery=off, and Clear keeps imagery off', () => {
    const { button, getHash, imageryCalls } = setup('#imagery=off&activity=hike', true);
    expect(button('Imagery').getAttribute('aria-pressed')).toBe('false');
    expect(imageryCalls).toEqual([false]);
    button('Clear Filters').click();
    expect(getHash()).toBe('#imagery=off');
    expect(imageryCalls).toEqual([false]);
  });
});

describe('buildings toggle', () => {
  it('has no Buildings button unless setBuildings is wired', () => {
    const { host } = setup('', true);
    expect(host.textContent).not.toContain('Buildings');
  });

  it('defaults on: pressed, the hash stays empty, and setBuildings(true) is called once', () => {
    const { button, getHash, buildingsCalls } = setup('', false, true);
    expect(button('Buildings').getAttribute('aria-pressed')).toBe('true');
    expect(getHash()).toBe('');
    expect(buildingsCalls).toEqual([true]);
  });

  it('toggling off writes buildings=off and calls setBuildings(false); toggling on clears it', () => {
    const { button, getHash, buildingsCalls } = setup('', true, true);
    button('Buildings').click();
    expect(button('Buildings').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('#buildings=off');
    button('Buildings').click();
    expect(getHash()).toBe('');
    expect(buildingsCalls).toEqual([true, false, true]);
  });

  it('starts off from #buildings=off, and Clear keeps buildings off and imagery independent', () => {
    const { button, getHash, buildingsCalls, imageryCalls } = setup(
      '#buildings=off&activity=hike',
      true,
      true,
    );
    expect(button('Buildings').getAttribute('aria-pressed')).toBe('false');
    expect(buildingsCalls).toEqual([false]);
    expect(imageryCalls).toEqual([true]);
    button('Clear Filters').click();
    expect(getHash()).toBe('#buildings=off');
    expect(buildingsCalls).toEqual([false]);
  });
});

describe('surface toggle', () => {
  it('has no Surface button unless setSurface is wired', () => {
    const { host } = setup('', true, true);
    expect(host.textContent).not.toContain('Surface');
  });

  it('sits after Buildings in the Layers group, defaults off, and leaves the hash empty', () => {
    const { host, button, getHash, surfaceCalls } = setup('', true, true, true);
    const labels = [...host.querySelectorAll('.console-group:last-child button .btn-label')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Imagery', 'Buildings', 'Surface']);
    expect(button('Surface').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('');
    expect(surfaceCalls).toEqual([false]);
  });

  it('toggling on writes surface=on and calls setSurface(true); toggling off clears it', () => {
    const { button, getHash, surfaceCalls } = setup('', false, false, true);
    button('Surface').click();
    expect(button('Surface').getAttribute('aria-pressed')).toBe('true');
    expect(getHash()).toBe('#surface=on');
    button('Surface').click();
    expect(getHash()).toBe('');
    expect(surfaceCalls).toEqual([false, true, false]);
  });

  it('starts on from #surface=on, and Clear leaves it alone', () => {
    const { button, getHash, surfaceCalls } = setup(
      '#surface=on&activity=hike',
      false,
      false,
      true,
    );
    expect(button('Surface').getAttribute('aria-pressed')).toBe('true');
    expect(surfaceCalls).toEqual([true]);
    button('Clear Filters').click();
    expect(getHash()).toBe('#surface=on');
    expect(surfaceCalls).toEqual([true]);
  });
});

describe('trees toggle', () => {
  it('has no Trees button unless setTrees is wired', () => {
    const { host } = setup('', true, true, true);
    expect(host.textContent).not.toContain('Trees');
  });

  it('sits after Surface in the Layers group, defaults off, and leaves the hash empty', () => {
    const { host, button, getHash, treesCalls } = setup('', true, true, true, false, true);
    const labels = [...host.querySelectorAll('.console-group:last-child button .btn-label')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Imagery', 'Buildings', 'Surface', 'Trees']);
    expect(button('Trees').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('');
    expect(treesCalls).toEqual([false]);
  });

  it('toggling on writes trees=on and calls setTrees(true); toggling off clears it', () => {
    const { button, getHash, treesCalls } = setup('', false, false, false, false, true);
    button('Trees').click();
    expect(button('Trees').getAttribute('aria-pressed')).toBe('true');
    expect(getHash()).toBe('#trees=on');
    button('Trees').click();
    expect(getHash()).toBe('');
    expect(treesCalls).toEqual([false, true, false]);
  });

  it('starts on from #trees=on, and Clear leaves it alone', () => {
    const { button, getHash, treesCalls } = setup(
      '#trees=on&activity=hike',
      false,
      false,
      false,
      false,
      true,
    );
    expect(button('Trees').getAttribute('aria-pressed')).toBe('true');
    expect(treesCalls).toEqual([true]);
    button('Clear Filters').click();
    expect(getHash()).toBe('#trees=on');
    expect(treesCalls).toEqual([true]);
  });
});

describe('terrain exaggeration slider', () => {
  const slider = (host: HTMLElement): HTMLInputElement => {
    const input = host.querySelector<HTMLInputElement>('input[type="range"]');
    if (input === null) throw new Error('no slider');
    return input;
  };
  const valueText = (host: HTMLElement): string =>
    host.querySelector('.exag-value')?.textContent ?? '';
  const drag = (input: HTMLInputElement, value: string): void => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('has no slider unless setExaggeration is wired', () => {
    const { host } = setup('', true, true, true);
    expect(host.querySelector('input[type="range"]')).toBeNull();
  });

  it('sits after Surface in the Layers group with the icon, label, 0 to 10 range and x1.0 at default', () => {
    const { host, getHash, exagCalls } = setup('', true, true, true, true);
    const layers = host.querySelector('[data-slot="imagery"]');
    const input = slider(host);
    expect(layers?.contains(input)).toBe(true);
    const surface = [...host.querySelectorAll('button')].find(
      (b) => b.querySelector('.btn-label')?.textContent === 'Surface',
    );
    expect(surface?.compareDocumentPosition(input)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect([input.min, input.max, input.step, input.value]).toEqual(['0.1', '10', '0.1', '1']);
    const icon = layers?.querySelector('.exag-key .ms');
    expect(icon?.textContent).toBe(iconFor('terrain-exaggeration').symbol);
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.exag-key')?.textContent).toContain('Terrain');
    expect(iconFor('terrain-exaggeration').symbol).toBe('height');
    expect(valueText(host)).toBe('x1.0');
    expect(getHash()).toBe('');
    expect(exagCalls).toEqual([1]);
  });

  it('is labelled for assistive technology and reports its value as text', () => {
    const { host } = setup('', false, false, false, true);
    const input = slider(host);
    expect(input.getAttribute('aria-label')).toBe('Terrain');
    drag(input, '2.5');
    expect(input.getAttribute('aria-valuetext')).toBe('x2.5');
  });

  it('updates the value text live, writes exag=<n> and calls setExaggeration', () => {
    const { host, getHash, exagCalls } = setup('', false, false, false, true);
    drag(slider(host), '2.5');
    expect(valueText(host)).toBe('x2.5');
    expect(getHash()).toBe('#exag=2.5');
    expect(exagCalls).toEqual([1, 2.5]);
    drag(slider(host), '0.1');
    expect(valueText(host)).toBe('x0.1');
    expect(getHash()).toBe('#exag=0.1');
    expect(exagCalls).toEqual([1, 2.5, 0.1]);
  });

  it('writes nothing for 1 and clears a previous exag', () => {
    const { host, getHash } = setup('', false, false, false, true);
    drag(slider(host), '3');
    expect(getHash()).toBe('#exag=3');
    drag(slider(host), '1');
    expect(getHash()).toBe('');
  });

  it('double-click resets to 1', () => {
    const { host, getHash, exagCalls } = setup('#exag=4', false, false, false, true);
    expect(slider(host).value).toBe('4');
    expect(exagCalls).toEqual([4]);
    slider(host).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(slider(host).value).toBe('1');
    expect(valueText(host)).toBe('x1.0');
    expect(getHash()).toBe('');
    expect(exagCalls).toEqual([4, 1]);
  });

  it('starts from #exag=2.5, and Clear leaves it alone', () => {
    const { host, button, getHash, exagCalls } = setup(
      '#exag=2.5&activity=hike',
      false,
      false,
      false,
      true,
    );
    expect(slider(host).value).toBe('2.5');
    expect(valueText(host)).toBe('x2.5');
    button('Clear Filters').click();
    expect(getHash()).toBe('#exag=2.5');
    expect(slider(host).value).toBe('2.5');
    expect(exagCalls).toEqual([2.5]);
  });

  it('drops exag=11 with the ignored notice and keeps the default', () => {
    const { host, getHash, exagCalls } = setup('#exag=11', false, false, false, true);
    expect(slider(host).value).toBe('1');
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: exag=11');
    expect(getHash()).toBe('');
    expect(exagCalls).toEqual([1]);
  });
});

describe('mountFilters and the #13 handle', () => {
  const HASH = '#activity=nordic-classic&season=winter';
  const registryWith = (line: Line2) =>
    new Map([['way/1', { area: makeArea('way/1', 'nordic-trail'), lines: [line] }]]);

  it('on a failed load applies no hash-derived filter, leaves the hash alone, and shows "filters unavailable"', () => {
    history.replaceState(null, '', `/${HASH}`);
    const line = new Line2();
    strips.push(
      mountFilters({ registry: registryWith(line), handle: failedAnnotationsHandle('HTTP 404') }),
    );
    expect(line.visible).toBe(true);
    expect(location.hash).toBe(HASH);
    expect(document.getElementById('filters')?.textContent).toBe(
      'filters unavailable: annotations failed to load',
    );
    window.dispatchEvent(new Event('hashchange'));
    expect(line.visible).toBe(true);
    expect(location.hash).toBe(HASH);
  });

  it('on a loaded handle applies the hash filter and reports the visible ids to onFilterApplied', () => {
    history.replaceState(null, '', '/#season=winter');
    const line = new Line2();
    const reported: ReadonlySet<string>[] = [];
    const handle: AnnotationsHandle = {
      ...failedAnnotationsHandle(''),
      annotations: { status: 'loaded', map: new Map() },
      onFilterApplied: (visibleIds) => {
        reported.push(visibleIds);
      },
    };
    strips.push(mountFilters({ registry: registryWith(line), handle }));
    expect(line.visible).toBe(false); // an unannotated trail is hidden while a filter is active
    expect(reported.length).toBeGreaterThan(0);
    expect([...(reported[reported.length - 1] ?? [])]).toEqual([]);
  });

  it('routes sport colour after applyFilter on every apply, with the annotations and the selected activities', () => {
    history.replaceState(null, '', '/#activity=nordic-skate&season=winter');
    const line = new Line2();
    const calls: { visibleAtCall: boolean; selected: string[]; size: number }[] = [];
    const map = new Map();
    const handle: AnnotationsHandle = {
      ...failedAnnotationsHandle(''),
      annotations: { status: 'loaded', map },
    };
    strips.push(
      mountFilters({
        registry: registryWith(line),
        handle,
        routeSport: (annotations, selected) => {
          calls.push({
            visibleAtCall: line.visible,
            selected: [...selected],
            size: annotations.size,
          });
          expect(annotations).toBe(map);
        },
      }),
    );
    expect(calls.length).toBeGreaterThan(0);
    // applyFilter has already hidden the unannotated trail when routeSport runs, so routing follows the filter.
    expect(calls[calls.length - 1]).toEqual({
      visibleAtCall: false,
      selected: ['nordic-skate'],
      size: 0,
    });
  });

  it('never routes sport colour when the annotations load failed', () => {
    history.replaceState(null, '', '/#activity=nordic-skate');
    let routed = 0;
    strips.push(
      mountFilters({
        registry: registryWith(new Line2()),
        handle: failedAnnotationsHandle('HTTP 404'),
        routeSport: () => {
          routed += 1;
        },
      }),
    );
    window.dispatchEvent(new Event('hashchange'));
    expect(routed).toBe(0);
  });
});

describe('rail markup', () => {
  const loadedHandle: AnnotationsHandle = {
    ...failedAnnotationsHandle(''),
    annotations: { status: 'loaded', map: new Map() },
  };
  const mountReal = (): HTMLElement => {
    strips.push(
      mountFilters({
        registry: new Map(),
        handle: loadedHandle,
        setImagery: () => {},
        setBuildings: () => {},
      }),
    );
    const host = document.getElementById('filters');
    if (host === null) throw new Error('no #filters');
    return host;
  };

  it('mounts inside the shared rail with no plate, box or background class anywhere', () => {
    const host = mountReal();
    expect(host.parentElement?.id).toBe('rail');
    expect(document.querySelector('.sm-plate')).toBeNull();
    expect(host.classList.contains('sm-plate')).toBe(false);
  });

  it('gives every key an aria-hidden .ms icon span and keeps the badge on each key', () => {
    const host = mountReal();
    const keys = [...host.querySelectorAll('button')];
    expect(keys).toHaveLength(TOGGLE_ACTIVITIES.length + 4 + 1 + 2);
    for (const key of keys) {
      const icon = key.querySelector(':scope > .btn-face > .ms');
      expect(icon, key.textContent ?? '').not.toBeNull();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('orders the groups Activity, Season, Clear then the status line, then Layers', () => {
    const host = mountReal();
    const order = [...host.children].map((c) =>
      c.classList.contains('console-foot')
        ? 'foot'
        : (c.querySelector('.group-head-text')?.textContent ?? '?'),
    );
    expect(order).toEqual(['Activity', 'Season', 'foot', 'Layers']);
    const foot = host.querySelector('.console-foot');
    const parts = [...(foot?.children ?? [])].map(
      (c) => c.querySelector('.btn-label')?.textContent ?? c.className,
    );
    expect(parts).toEqual(['Clear Filters', 'filter-count', 'filter-notice']);
  });

  it('labels each group by its header and marks the header icon aria-hidden', () => {
    const host = mountReal();
    for (const group of host.querySelectorAll('.console-group')) {
      const head = group.querySelector('.group-head');
      expect(group.getAttribute('aria-labelledby')).toBe(head?.id);
      expect(head?.querySelector('.ms')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('phone layout is structural: a scrolling row whose headers are chips, same keys', () => {
    const host = mountReal();
    // jsdom has no layout, so assert the structure the phone CSS targets and that the CSS declares the row.
    const css = readFileSync(resolve(__dirname, '../../src/ui/rail.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'));
    expect(phone).toMatch(/#rail \{[^}]*flex-direction: row;/);
    expect(phone).toMatch(/overflow-x: auto;/);
    expect(phone).toMatch(/#rail \.group-head \{[^}]*border-radius: 999px;/);
    expect(host.querySelectorAll('.console-group > .group-head')).toHaveLength(3);
    expect(host.querySelectorAll('.console-group .key-row .cl-key').length).toBeGreaterThan(0);
  });
});

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

function setup(initialHash: string, withImagery = false, withBuildings = false) {
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

// @vitest-environment jsdom
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
import { mountFilters } from '../../src/ui/mount-filters';
import { failedAnnotationsHandle, type AnnotationsHandle } from '../../src/wire-annotations';
import { makeArea } from './filter-fixtures';

const strips: FilterStrip[] = [];

afterEach(() => {
  for (const strip of strips.splice(0)) strip.dispose();
  document.body.replaceChildren();
  history.replaceState(null, '', location.pathname + location.search);
});

function setup(initialHash: string) {
  let hash = initialHash;
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
    readHash: () => hash,
    writeHash: (h) => {
      hash = h;
      writes.push(h);
    },
  });
  strips.push(strip);
  const button = (text: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').replace('✓ ', '') === text,
    );
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  };
  return { host, strip, button, writes, getHash: () => hash, calls: () => applyCalls };
}

describe('filter strip', () => {
  it('generates toggles from the schemas and omits lift-ride', () => {
    const { host } = setup('');
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('lift-ride');
    expect(labels.filter((l) => ActivitySchema.options.includes(l as never))).toHaveLength(
      ActivitySchema.options.length - 1,
    );
    for (const season of SeasonSchema.options) expect(labels).toContain(season);
  });

  it('flips aria-pressed, writes the canonical hash and updates the count on click', () => {
    const { host, button, getHash } = setup('');
    button('nordic-classic').click();
    expect(button('nordic-classic').getAttribute('aria-pressed')).toBe('true');
    expect(getHash()).toBe('#activity=nordic-classic');
    expect(host.querySelector('.filter-count')?.textContent).toBe('3 of 5 areas');
    button('nordic-classic').click();
    expect(button('nordic-classic').getAttribute('aria-pressed')).toBe('false');
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
    expect(button('winter').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores an unknown key, shows it in the notice, and rewrites the hash without it', () => {
    const { host, getHash } = setup('#season=winter&view=x');
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: view=x');
    expect(getHash()).toBe('#season=winter');
  });

  it('clears all toggles', () => {
    const { host, button, getHash } = setup('#activity=hike&season=winter');
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear')?.click();
    expect(getHash()).toBe('');
    expect(button('hike').getAttribute('aria-pressed')).toBe('false');
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
    expect(key('nordic-classic').querySelector('.btn-count')?.textContent).toBe('40');
    expect(key('winter').querySelector('.btn-count')?.textContent).toBe('12');
    expect(key('spring').querySelector('.btn-count')?.textContent).toBe('0');
  });

  it('renders a zero-count option as aria-disabled with the explanatory title, still focusable', () => {
    const { key } = setupFacets('');
    for (const label of ['hike', 'tubing', 'spring']) {
      const button = key(label);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.title).toBe(NO_MATCH_TITLE);
      expect(button.disabled).toBe(false);
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.closest('.cl-key')?.classList.contains('is-zero')).toBe(true);
    }
    expect(key('nordic-classic').hasAttribute('aria-disabled')).toBe(false);
    expect(key('nordic-classic').hasAttribute('title')).toBe(false);
  });

  it('ignores a click on a zero-count option and leaves the hash alone', () => {
    const { key, getHash } = setupFacets('');
    key('spring').click();
    expect(key('spring').getAttribute('aria-pressed')).toBe('false');
    expect(getHash()).toBe('');
  });

  it('keeps a latched zero-count option operable so it can be switched off', () => {
    const { key, getHash } = setupFacets('#season=spring', 0);
    expect(key('spring').getAttribute('aria-pressed')).toBe('true');
    expect(key('spring').hasAttribute('aria-disabled')).toBe(false);
    key('spring').click();
    expect(key('spring').getAttribute('aria-pressed')).toBe('false');
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

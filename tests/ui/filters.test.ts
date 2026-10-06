// @vitest-environment jsdom
import { Line2 } from 'three/addons/lines/Line2.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivitySchema, SeasonSchema } from '../../src/schema/annotation';
import { mountFilterStrip, type FilterStrip } from '../../src/ui/filters';
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

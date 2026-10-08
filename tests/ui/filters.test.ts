// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Line2 } from 'three/addons/lines/Line2.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivitySchema, SeasonSchema } from '../../src/schema/annotation';
import type {
  Activity,
  FacetCounts,
  Filter,
  Season,
  SeasonCounts,
} from '../../src/ui/filter-predicate';
import type { SeasonMap } from '../../src/ui/season-menu';
import { mountFilterStrip, TOGGLE_ACTIVITIES, type FilterStrip } from '../../src/ui/filters';
import { iconFor } from '../../src/ui/icons';
import { mountFilters } from '../../src/ui/mount-filters';
import { failedAnnotationsHandle, type AnnotationsHandle } from '../../src/wire-annotations';
import { entry, makeAnnotation, makeArea } from './filter-fixtures';

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
  it('the rail carries no activity or season key (#56): activities live only in the season menu row', () => {
    const { host } = setup('');
    const labels = [...host.querySelectorAll('button .btn-label')].map((b) => b.textContent);
    expect(labels).toEqual(['Clear Filters']);
    for (const id of ActivitySchema.options) {
      expect(labels).not.toContain(iconFor(id).label);
      expect(labels).not.toContain(id);
    }
    for (const season of SeasonSchema.options) expect(labels).not.toContain(iconFor(season).label);
    expect(TOGGLE_ACTIVITIES).toHaveLength(ActivitySchema.options.length - 1);
    expect(host.querySelectorAll('.key-row')).toHaveLength(0);
  });

  it('shows the ignored notice for a bad hash and rewrites it canonically', () => {
    const { host, getHash } = setup('#activity=foo');
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: foo');
    expect(getHash()).toBe('');
  });

  it('does not write when the hash is already canonical', () => {
    // Bare-season normalisation is covered in the season menu integration suite below.
    const { writes, getHash } = setup('#activity=hike');
    expect(writes).toHaveLength(0);
    expect(getHash()).toBe('#activity=hike');
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
  });

  it('stops reacting to hashchange after dispose', () => {
    const { strip, calls } = setup('');
    strip.dispose();
    const before = calls();
    window.dispatchEvent(new Event('hashchange'));
    expect(calls()).toBe(before);
  });
});

describe('facet counts and the status line', () => {
  // Only nordic-classic (40) and winter (12) have matches; everything else is zero. The status line reads the totals.
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
    return { host, getHash: () => hash };
  };

  it('has no activity keys in the rail, whatever the facets say', () => {
    const { host } = setupFacets('');
    const labels = [...host.querySelectorAll('button .btn-label')].map((b) => b.textContent);
    expect(labels).toEqual(['Clear Filters']);
  });

  it('words the status line for no filter and for an active filter', () => {
    const idle = setupFacets('');
    expect(idle.host.querySelector('.filter-count')?.textContent).toBe('107 trails · 8 lifts');
    const active = setupFacets('#activity=nordic-classic', 40);
    expect(active.host.querySelector('.filter-count')?.textContent).toBe(
      '40 of 107 trails match · 8 lifts always shown',
    );
  });
});

describe('season menu integration (#42)', () => {
  const WINTER: readonly Activity[] = ['alpine-ski', 'snowboard', 'nordic-classic', 'nordic-skate'];
  const WINTER_HASH = '#activity=alpine-ski,snowboard,nordic-classic,nordic-skate&season=winter';
  const seasonMap: SeasonMap = new Map<Season, readonly Activity[]>([
    ['winter', WINTER],
    ['spring', []],
    ['summer', ['mountain-bike']],
    ['fall', ['mountain-bike']],
  ]);
  const counts: SeasonCounts = {
    seasons: new Map<Season, number>([
      ['winter', 63],
      ['spring', 0],
      ['summer', 44],
      ['fall', 44],
    ]),
    activities: new Map<Season, ReadonlyMap<Activity, number>>([
      [
        'winter',
        new Map<Activity, number>([
          ['alpine-ski', 23],
          ['snowboard', 21],
          ['nordic-classic', 40],
          ['nordic-skate', 38],
        ]),
      ],
      ['spring', new Map()],
      ['summer', new Map<Activity, number>([['mountain-bike', 44]])],
      ['fall', new Map<Activity, number>([['mountain-bike', 44]])],
    ]),
  };
  // facetCounts reports the same union count for every activity in season mode; season mode must not use it.
  const facets: FacetCounts = {
    activities: new Map(TOGGLE_ACTIVITIES.map((a) => [a, 63] as const)),
    seasons: new Map(SeasonSchema.options.map((s) => [s, 0] as const)),
    matching: 63,
    lifts: 8,
    candidates: 107,
  };

  const setupSeason = (initialHash: string) => {
    let hash = initialHash;
    const writes: string[] = [];
    let lastFilter: Filter | undefined;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const strip = mountFilterStrip({
      host,
      apply: (filter) => {
        lastFilter = filter;
        return { visibleCount: 0, total: 115, facets };
      },
      readHash: () => hash,
      writeHash: (h) => {
        hash = h;
        writes.push(h);
      },
      seasonMap,
      seasonCounts: counts,
    });
    strips.push(strip);
    const find = (root: ParentNode, label: string): HTMLButtonElement => {
      const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.querySelector('.btn-label')?.textContent === label,
      );
      if (found === undefined) throw new Error(`no key ${label}`);
      return found;
    };
    const bar = (): HTMLElement => {
      const found = document.getElementById('season-bar');
      if (found === null) throw new Error('no #season-bar');
      return found;
    };
    const row = (): HTMLElement => {
      const found = bar().querySelector<HTMLElement>('.sm-season-row');
      if (found === null) throw new Error('no row');
      return found;
    };
    return {
      host,
      strip,
      writes,
      bar,
      row,
      rail: (label: string) => find(host, label),
      applied: (): Filter => {
        if (lastFilter === undefined) throw new Error('apply never ran');
        return lastFilter;
      },
      season: (label: string) => find(bar().querySelector('.sm-season-keys') ?? bar(), label),
      rowKey: (label: string) => find(row(), label),
      getHash: () => hash,
      setHash: (h: string) => {
        hash = h;
      },
    };
  };

  it('appends the bar to document.body, outside the rail, and removes it on dispose', () => {
    const { host, bar, strip } = setupSeason('');
    expect(bar().parentElement).toBe(document.body);
    expect(host.contains(bar())).toBe(false);
    strip.dispose();
    expect(document.getElementById('season-bar')).toBeNull();
  });

  it('has no Season group in the rail', () => {
    const { host } = setupSeason('');
    const heads = [...host.querySelectorAll('.group-head-text')].map((h) => h.textContent);
    expect(heads).not.toContain('Season');
    const labels = [...host.querySelectorAll('.btn-label')].map((l) => l.textContent);
    for (const s of SeasonSchema.options) expect(labels).not.toContain(iconFor(s).label);
  });

  it('selecting Winter writes the expanded hash and keeps the layer keys', () => {
    const { season, getHash, row, rowKey } = setupSeason('#imagery=off&surface=on&exag=2.5');
    season('Winter').click();
    expect(getHash()).toBe(`${WINTER_HASH}&imagery=off&surface=on&exag=2.5`);
    expect(row().hidden).toBe(false);
    expect(rowKey('Snowboard').getAttribute('aria-pressed')).toBe('true');
    season('Summer').click();
    expect(getHash()).toBe('#activity=mountain-bike&season=summer&imagery=off&surface=on&exag=2.5');
  });

  it('unchecking in the row shrinks the list; the last one clears both; pressing the active season clears both', () => {
    const { season, rowKey, getHash, row } = setupSeason('');
    season('Winter').click();
    rowKey('Snowboard').click();
    expect(getHash()).toBe('#activity=alpine-ski,nordic-classic,nordic-skate&season=winter');
    season('Winter').click();
    expect(getHash()).toBe('');
    expect(row().hidden).toBe(true);
    season('Summer').click();
    rowKey('Mountain Bike').click();
    expect(getHash()).toBe('');
  });

  it('pressing Spring writes nothing', () => {
    const { season, writes } = setupSeason('');
    season('Spring').click();
    expect(writes).toHaveLength(0);
  });

  it('normalises on mount: a bare season expands and writes once; sync() twice still writes once', () => {
    const { writes, strip, getHash } = setupSeason('#season=winter');
    expect(getHash()).toBe(WINTER_HASH);
    strip.sync();
    expect(writes).toEqual([WINTER_HASH]);
  });

  it('normalises on mount: hike with winter becomes the full winter list; two seasons keep winter; spring is dropped', () => {
    expect(setupSeason('#activity=hike&season=winter').getHash()).toBe(WINTER_HASH);
    expect(setupSeason('#season=winter,summer').getHash()).toBe(WINTER_HASH);
    expect(setupSeason('#season=spring').getHash()).toBe('');
  });

  it('a hashchange re-renders the bar and the row', () => {
    const { setHash, season, row, rowKey } = setupSeason(WINTER_HASH);
    expect(season('Winter').getAttribute('aria-expanded')).toBe('true');
    setHash('#season=summer');
    window.dispatchEvent(new Event('hashchange'));
    expect(season('Winter').getAttribute('aria-expanded')).toBe('false');
    expect(season('Summer').getAttribute('aria-expanded')).toBe('true');
    expect(row().querySelectorAll('button')).toHaveLength(1);
    expect(rowKey('Mountain Bike').getAttribute('aria-pressed')).toBe('true');
  });

  it('default view: no season, no activity keys anywhere, the row is hidden and empty', () => {
    const { host, row, bar } = setupSeason('');
    expect(row().hidden).toBe(true);
    expect(row().querySelectorAll('button')).toHaveLength(0);
    expect(bar().hasAttribute('data-open')).toBe(false);
    const labels = [...document.querySelectorAll('button .btn-label')].map((l) => l.textContent);
    for (const a of ActivitySchema.options) expect(labels).not.toContain(iconFor(a).label);
    expect(host.querySelectorAll('.cl-key.is-off-season')).toHaveLength(0);
  });

  it('selecting Winter shows only winter activities, all on, with per-activity counts; the rail gains no keys', () => {
    const { season, row, rowKey, host } = setupSeason('');
    season('Winter').click();
    const labels = [...row().querySelectorAll('.btn-label')].map((l) => l.textContent);
    expect(labels).toEqual(WINTER.map((a) => iconFor(a).label));
    for (const b of row().querySelectorAll('button')) {
      expect(b.getAttribute('aria-pressed')).toBe('true');
    }
    expect(rowKey('Alpine Ski').querySelector('.btn-count')?.textContent).toBe('23');
    expect(rowKey('Snowboard').querySelector('.btn-count')?.textContent).toBe('21');
    expect(rowKey('Nordic Skate').querySelector('.btn-count')?.textContent).toBe('38');
    expect([...host.querySelectorAll('button .btn-label')].map((l) => l.textContent)).toEqual([
      'Clear Filters',
    ]);
  });

  it('toggling one winter activity off passes the shrunk set to apply; deselecting the season restores the default view', () => {
    const { season, rowKey, getHash, row, applied } = setupSeason('');
    season('Winter').click();
    rowKey('Snowboard').click();
    expect([...applied().activities]).toEqual(['alpine-ski', 'nordic-classic', 'nordic-skate']);
    expect(rowKey('Snowboard').getAttribute('aria-pressed')).toBe('false');
    season('Winter').click();
    expect(getHash()).toBe('');
    expect(row().hidden).toBe(true);
    expect(row().querySelectorAll('button')).toHaveLength(0);
    expect([...applied().activities]).toEqual([]);
    expect([...applied().seasons]).toEqual([]);
  });

  it('Clear Filters clears the season and its activities', () => {
    const { rail, getHash, row } = setupSeason(WINTER_HASH);
    rail('Clear Filters').click();
    expect(getHash()).toBe('');
    expect(row().hidden).toBe(true);
  });

  it('Escape in the row focuses the active season key and leaves the hash unchanged', () => {
    const { rowKey, season, writes, getHash } = setupSeason(WINTER_HASH);
    const key = rowKey('Nordic Classic');
    key.focus();
    key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(season('Winter'));
    expect(writes).toHaveLength(0);
    expect(getHash()).toBe(WINTER_HASH);
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

  it('sits after Buildings in the Layers popout, defaults off, and leaves the hash empty', () => {
    const { host, button, getHash, surfaceCalls } = setup('', true, true, true);
    const labels = [...host.querySelectorAll('.sm-popout-panel button .btn-label')].map(
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

  it('sits after Surface in the Layers popout, defaults off, and leaves the hash empty', () => {
    const { host, button, getHash, treesCalls } = setup('', true, true, true, false, true);
    const labels = [...host.querySelectorAll('.sm-popout-panel button .btn-label')].map(
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

describe('terrain exaggeration (DEBUG slider, #58)', () => {
  const setupExag = (initialHash: string) => {
    const shown: number[] = [];
    const applied: number[] = [];
    let hash = initialHash;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const strip = mountFilterStrip({
      host,
      apply: () => ({ visibleCount: 3, total: 5 }),
      setExaggeration: (k) => void applied.push(k),
      showExaggeration: (k) => void shown.push(k),
      readHash: () => hash,
      writeHash: (h) => {
        hash = h;
      },
    });
    strips.push(strip);
    return { host, strip, shown, applied, getHash: () => hash };
  };

  it('puts no slider in the rail or the Layers popout', () => {
    const { host } = setup('', true, true, true, true);
    expect(host.querySelector('input[type="range"]')).toBeNull();
    expect(document.querySelector('.exag-key')).toBeNull();
  });

  it('reads #exag=3 on mount: the scene setter and the slider both get 3', () => {
    const { shown, applied, getHash } = setupExag('#exag=3');
    expect(applied).toEqual([3]);
    expect(shown).toEqual([3]);
    expect(getHash()).toBe('#exag=3');
  });

  it('setExaggeration writes exag=<n>, applies it, and writes nothing for 1', () => {
    const { strip, shown, applied, getHash } = setupExag('');
    expect(applied).toEqual([1]);
    strip.setExaggeration(2.5);
    expect(getHash()).toBe('#exag=2.5');
    expect(applied).toEqual([1, 2.5]);
    expect(shown.at(-1)).toBe(2.5);
    strip.setExaggeration(0.1);
    expect(getHash()).toBe('#exag=0.1');
    strip.setExaggeration(1);
    expect(getHash()).toBe('');
    expect(applied).toEqual([1, 2.5, 0.1, 1]);
  });

  it('Clear leaves exag alone', () => {
    const { host, getHash, applied } = setupExag('#exag=2.5&activity=hike');
    const clear = [...host.querySelectorAll('button')].find(
      (b) => b.querySelector('.btn-label')?.textContent === 'Clear Filters',
    );
    clear?.click();
    expect(getHash()).toBe('#exag=2.5');
    expect(applied).toEqual([2.5]);
  });

  it('drops exag=11 with the ignored notice and keeps the default', () => {
    const { host, getHash, applied } = setupExag('#exag=11');
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: exag=11');
    expect(getHash()).toBe('');
    expect(applied).toEqual([1]);
  });

  it('mountFilters registers "Terrain exaggeration" (0.1 to 10, step 0.1) in the DEBUG panel and wires it to the hash', () => {
    const applied: number[] = [];
    history.replaceState(null, '', location.pathname + location.search + '#exag=3');
    strips.push(
      mountFilters({
        registry: new Map(),
        handle: {
          ...failedAnnotationsHandle(''),
          annotations: { status: 'loaded', map: new Map() },
        },
        setExaggeration: (k) => void applied.push(k),
      }),
    );
    const input = document.querySelector<HTMLInputElement>('#debug-panel input[type="range"]');
    if (input === null) throw new Error('no DEBUG slider');
    expect([input.min, input.max, input.step]).toEqual(['0.1', '10', '0.1']);
    expect(document.querySelector('#debug-panel')?.textContent).toContain('Terrain exaggeration');
    expect(input.value).toBe('3');
    expect(applied).toEqual([3]);
    input.value = '4.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(location.hash).toBe('#exag=4.5');
    expect(applied).toEqual([3, 4.5]);
    location.hash = '#exag=2';
    window.dispatchEvent(new Event('hashchange'));
    expect(input.value).toBe('2');
    expect(applied).toEqual([3, 4.5, 2]);
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
    // Another area offers nordic-classic in winter, so the bare season expands instead of being dropped.
    const map = new Map([
      ['way/9', makeAnnotation('way/9', [entry('nordic-classic', ['winter'])])],
    ]);
    const handle: AnnotationsHandle = {
      ...failedAnnotationsHandle(''),
      annotations: { status: 'loaded', map },
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
    // Clear only: the layer switches live in the top bar's Layers popout and the season keys beside them (#58, #56).
    expect(keys).toHaveLength(1);
    for (const key of keys) {
      const icon = key.querySelector(':scope > .btn-face > .ms');
      expect(icon, key.textContent ?? '').not.toBeNull();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('orders the rail Clear then the notice; the status line sits in the top bar under the season keys', () => {
    const host = mountReal();
    expect([...host.children].map((c) => c.className)).toEqual(['console-foot']);
    const foot = host.querySelector('.console-foot');
    const parts = [...(foot?.children ?? [])].map(
      (c) => c.querySelector('.btn-label')?.textContent ?? c.className,
    );
    expect(parts).toEqual(['Clear Filters', 'filter-notice']);
    expect(host.querySelector('.filter-count')).toBeNull();
    expect(document.querySelector('#season-bar > .filter-count')?.textContent).toBe(
      '0 trails · 0 lifts',
    );
  });

  it('hides the rail section while no filter is active and shows it for a season or a notice', () => {
    const host = mountReal();
    expect(host.hidden).toBe(true);
    history.replaceState(null, '', location.pathname + location.search + '#activity=hike');
    window.dispatchEvent(new Event('hashchange'));
    expect(host.hidden).toBe(false);
    history.replaceState(null, '', location.pathname + location.search + '#activity=foo');
    window.dispatchEvent(new Event('hashchange'));
    expect(host.querySelector('.filter-notice')?.textContent).toBe('ignored: foo');
    expect(host.hidden).toBe(false);
    history.replaceState(null, '', location.pathname + location.search);
    window.dispatchEvent(new Event('hashchange'));
    expect(host.hidden).toBe(true);
  });

  it('mounts the Layers popout at the right end of the top bar with its toggles in the panel', () => {
    mountReal();
    const popout = document.querySelector('#season-bar .sm-bar-keys > .sm-popout--end');
    const trigger = popout?.querySelector<HTMLButtonElement>(':scope > .cl-key button');
    expect(trigger?.querySelector('.btn-label')?.textContent).toBe('Layers');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(trigger?.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(true);
    trigger?.click();
    expect(panel?.hidden).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const labels = [...(panel?.querySelectorAll('button .btn-label') ?? [])].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Imagery', 'Buildings']);
    // A layer toggle keeps the popout open.
    panel?.querySelector<HTMLButtonElement>('button')?.click();
    expect(panel?.hidden).toBe(false);
  });

  it('phone layout is structural: a scrolling row whose headers are chips, same keys', () => {
    const host = mountReal();
    // jsdom has no layout, so assert the structure the phone CSS targets and that the CSS declares the row.
    const css = readFileSync(resolve(__dirname, '../../src/ui/rail.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'));
    expect(phone).toMatch(/#rail \{[^}]*flex-direction: row;/);
    expect(phone).toMatch(/overflow-x: auto;/);
    expect(phone).toMatch(/#rail \.group-head \{[^}]*border-radius: 999px;/);
    // No group headers or key rows are left in the rail: Season moved to the top bar (#42), Activity to the season row (#56), Layers and View to popouts (#58).
    expect(host.querySelectorAll('.group-head, .key-row, .console-group')).toHaveLength(0);
  });
});

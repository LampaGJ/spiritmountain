// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  decodeHash,
  encodeHash,
  HashFilterSchema,
  type HashFilter,
} from '../../src/ui/filter-hash';
import { SeasonSchema } from '../../src/schema/annotation';
import type { Activity, Season, SeasonCounts } from '../../src/ui/filter-predicate';
import { NO_MATCH_TITLE } from '../../src/ui/filters';
import { iconFor } from '../../src/ui/icons';
import {
  buildSeasonBar,
  normalizeSeason,
  selectSeason,
  toggleSeasonActivity,
  type SeasonMap,
} from '../../src/ui/season-menu';

const WINTER: readonly Activity[] = ['alpine-ski', 'snowboard', 'nordic-classic', 'nordic-skate'];
/** The seed's shape: spring empty, summer and fall mountain-bike only. */
const MAP: SeasonMap = new Map<Season, readonly Activity[]>([
  ['winter', WINTER],
  ['spring', []],
  ['summer', ['mountain-bike']],
  ['fall', ['mountain-bike']],
]);
const EMPTY: HashFilter = { activity: [], season: [] };
const LAYERS = { imagery: false, surface: true, exag: 2.5 } as const;
const WINTER_HASH = '#activity=alpine-ski,snowboard,nordic-classic,nordic-skate&season=winter';

describe('selectSeason', () => {
  it('selects Winter from empty with every winter activity on, writing the expected hash', () => {
    const next = selectSeason(EMPTY, 'winter', MAP);
    expect(next).toEqual({ activity: [...WINTER], season: ['winter'] });
    expect(encodeHash(next)).toBe(WINTER_HASH);
  });

  it('keeps imagery, surface and exag when selecting and switching', () => {
    const winter = selectSeason({ ...EMPTY, ...LAYERS }, 'winter', MAP);
    expect(encodeHash(winter)).toBe(`${WINTER_HASH}&imagery=off&surface=on&exag=2.5`);
    const summer = selectSeason(winter, 'summer', MAP);
    expect(summer).toEqual({ activity: ['mountain-bike'], season: ['summer'], ...LAYERS });
  });

  it('switching Winter to Summer replaces the list, not merges it', () => {
    const winter = selectSeason(EMPTY, 'winter', MAP);
    const partial = toggleSeasonActivity(winter, 'snowboard', MAP);
    expect(selectSeason(partial, 'summer', MAP)).toEqual({
      activity: ['mountain-bike'],
      season: ['summer'],
    });
  });

  it('pressing the active season clears both keys and keeps the layers', () => {
    const winter = selectSeason({ ...EMPTY, ...LAYERS }, 'winter', MAP);
    expect(selectSeason(winter, 'winter', MAP)).toEqual({ ...EMPTY, ...LAYERS });
  });

  it('is a no-op for a season with no activities (Spring)', () => {
    const state: HashFilter = { activity: ['hike'], season: [], ...LAYERS };
    expect(selectSeason(state, 'spring', MAP)).toBe(state);
  });
});

describe('toggleSeasonActivity', () => {
  const winter = selectSeason({ ...EMPTY, ...LAYERS }, 'winter', MAP);

  it('unchecking one activity shrinks the list and keeps the season and layers', () => {
    const next = toggleSeasonActivity(winter, 'snowboard', MAP);
    expect(next).toEqual({
      activity: ['alpine-ski', 'nordic-classic', 'nordic-skate'],
      season: ['winter'],
      ...LAYERS,
    });
  });

  it('re-checking restores schema order', () => {
    const next = toggleSeasonActivity(
      toggleSeasonActivity(winter, 'alpine-ski', MAP),
      'alpine-ski',
      MAP,
    );
    expect(next.activity).toEqual([...WINTER]);
  });

  it('unchecking the last activity clears both keys', () => {
    const summer = selectSeason(EMPTY, 'summer', MAP);
    expect(toggleSeasonActivity(summer, 'mountain-bike', MAP)).toEqual(EMPTY);
    let state = winter;
    for (const a of WINTER) state = toggleSeasonActivity(state, a, MAP);
    expect(state).toEqual({ ...EMPTY, ...LAYERS });
  });

  it('ignores an activity the season does not offer', () => {
    expect(toggleSeasonActivity(winter, 'hike', MAP)).toBe(winter);
  });
});

describe('normalizeSeason', () => {
  const norm = (hash: string): string => encodeHash(normalizeSeason(decodeHash(hash).filter, MAP));

  it('expands a bare season to its full list', () => {
    expect(norm('#season=winter')).toBe(WINTER_HASH);
  });

  it('intersects activities with the season, expanding an empty result', () => {
    expect(norm('#activity=hike&season=winter')).toBe(WINTER_HASH);
    expect(norm('#activity=snowboard,hike&season=winter')).toBe(
      '#activity=snowboard&season=winter',
    );
  });

  it('keeps the first of several seasons in schema order', () => {
    expect(norm('#season=summer,winter')).toBe(WINTER_HASH);
  });

  it('drops a season with no activities', () => {
    expect(norm('#season=spring')).toBe('');
    expect(norm('#activity=hike&season=spring')).toBe('#activity=hike');
  });

  it('leaves a state with no season untouched', () => {
    const state: HashFilter = { activity: ['hike'], season: [], ...LAYERS };
    expect(normalizeSeason(state, MAP)).toBe(state);
  });

  it('is idempotent, schema-valid, and round-trips through the codec', () => {
    const hashes = [
      '',
      '#season=winter',
      '#activity=hike&season=winter',
      '#season=winter,summer',
      '#season=spring',
      '#activity=snowboard&season=winter&imagery=off&exag=3',
      '#activity=hike',
    ];
    for (const hash of hashes) {
      const once = normalizeSeason(decodeHash(hash).filter, MAP);
      expect(normalizeSeason(once, MAP), hash).toEqual(once);
      expect(HashFilterSchema.parse(once), hash).toEqual(once);
      expect(decodeHash(encodeHash(once)).filter, hash).toEqual(once);
    }
  });
});

describe('buildSeasonBar (jsdom)', () => {
  const COUNTS: SeasonCounts = {
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
          ['snowboard', 23],
          ['nordic-classic', 40],
          ['nordic-skate', 40],
        ]),
      ],
      ['spring', new Map()],
      ['summer', new Map<Activity, number>([['mountain-bike', 44]])],
      ['fall', new Map<Activity, number>([['mountain-bike', 44]])],
    ]),
  };

  const mount = () => {
    const seasons: Season[] = [];
    const activities: Activity[] = [];
    const bar = buildSeasonBar({
      map: MAP,
      counts: COUNTS,
      onSeason: (s) => void seasons.push(s),
      onActivity: (a) => void activities.push(a),
    });
    document.body.replaceChildren(bar.root);
    const seasonKey = (label: string): HTMLButtonElement => {
      const found = [
        ...bar.root.querySelectorAll<HTMLButtonElement>('.sm-season-keys button'),
      ].find((b) => b.querySelector('.btn-label')?.textContent === label);
      if (found === undefined) throw new Error(`no season key ${label}`);
      return found;
    };
    const row = (): HTMLElement => {
      const found = bar.root.querySelector<HTMLElement>('.sm-season-row');
      if (found === null) throw new Error('no row');
      return found;
    };
    return { bar, seasons, activities, seasonKey, row };
  };

  it('is a nav#season-bar labelled Season with four season toggle keys and their glyphs', () => {
    const { bar } = mount();
    expect(bar.root.tagName).toBe('NAV');
    expect(bar.root.id).toBe('season-bar');
    expect(bar.root.classList.contains('sm-season-bar')).toBe(true);
    expect(bar.root.getAttribute('aria-label')).toBe('Season');
    const keys = [...bar.root.querySelectorAll('.sm-season-keys button.clicky-toggle')];
    expect(keys.map((k) => k.querySelector('.btn-label')?.textContent)).toEqual(
      SeasonSchema.options.map((s) => iconFor(s).label),
    );
    expect(keys.map((k) => k.querySelector('.ms')?.textContent)).toEqual(
      SeasonSchema.options.map((s) => iconFor(s).symbol),
    );
  });

  it('closed: no data-open, row hidden, every aria-expanded false, season badges shown', () => {
    const { bar, seasonKey, row } = mount();
    bar.render(EMPTY);
    expect(bar.root.hasAttribute('data-open')).toBe(false);
    expect(row().hidden).toBe(true);
    for (const s of SeasonSchema.options) {
      const key = seasonKey(iconFor(s).label);
      expect(key.getAttribute('aria-expanded')).toBe('false');
      expect(key.getAttribute('aria-pressed')).toBe('false');
    }
    expect(seasonKey('Winter').querySelector('.btn-count')?.textContent).toBe('63');
  });

  it('open: aria-expanded is true exactly on the active key and only while the row is shown; aria-controls resolves', () => {
    const { bar, seasonKey, row } = mount();
    bar.render(selectSeason(EMPTY, 'winter', MAP));
    expect(bar.root.hasAttribute('data-open')).toBe(true);
    expect(row().hidden).toBe(false);
    expect(seasonKey('Winter').getAttribute('aria-expanded')).toBe('true');
    expect(seasonKey('Winter').getAttribute('aria-pressed')).toBe('true');
    expect(seasonKey('Summer').getAttribute('aria-expanded')).toBe('false');
    const controls = seasonKey('Winter').getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    expect(document.getElementById(controls ?? '')).toBe(row());
  });

  it('the row is a named group of the season activities, all pressed, with per-activity counts', () => {
    const { bar, row } = mount();
    bar.render(toggleSeasonActivity(selectSeason(EMPTY, 'winter', MAP), 'snowboard', MAP));
    expect(row().getAttribute('role')).toBe('group');
    expect(row().getAttribute('aria-label')).toBe('Season activities');
    const keys = [...row().querySelectorAll('button')];
    expect(keys.map((k) => k.querySelector('.btn-label')?.textContent)).toEqual(
      WINTER.map((a) => iconFor(a).label),
    );
    expect(keys.map((k) => k.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'true',
      'true',
    ]);
    expect(keys.map((k) => k.querySelector('.btn-count')?.textContent)).toEqual([
      '23',
      '23',
      '40',
      '40',
    ]);
  });

  it('season and activity clicks report to the callbacks; Spring is disabled and reports nothing', () => {
    const { bar, seasons, activities, seasonKey, row } = mount();
    bar.render(EMPTY);
    const spring = seasonKey('Spring');
    expect(spring.getAttribute('aria-disabled')).toBe('true');
    expect(spring.title).toBe(NO_MATCH_TITLE);
    expect(spring.closest('.cl-key')?.classList.contains('is-zero')).toBe(true);
    spring.click();
    expect(seasons).toEqual([]);
    seasonKey('Winter').click();
    expect(seasons).toEqual(['winter']);
    bar.render(selectSeason(EMPTY, 'winter', MAP));
    row().querySelector('button')?.click();
    expect(activities).toEqual(['alpine-ski']);
  });

  it('Escape in the row focuses the active season key and calls nothing', () => {
    const { bar, seasons, activities, seasonKey, row } = mount();
    bar.render(selectSeason(EMPTY, 'summer', MAP));
    const inRow = row().querySelector('button');
    inRow?.focus();
    inRow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(seasonKey('Summer'));
    expect(row().hidden).toBe(false);
    expect(seasons).toEqual([]);
    expect(activities).toEqual([]);
  });
});

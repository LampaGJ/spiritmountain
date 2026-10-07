import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  matchesFilter,
  type Activity,
  type Filter,
  type Season,
} from '../../src/ui/filter-predicate';
import { entry, makeAnnotation, makeArea } from './filter-fixtures';
import type { Area } from '../../src/schema/area';
import type { Annotation } from '../../src/schema/annotation';

const filterOf = (activities: Activity[] = [], seasons: Season[] = []): Filter => ({
  activities: new Set(activities),
  seasons: new Set(seasons),
});

const twoEntryArea = makeArea('way/1', 'mtb-trail');
const twoEntryNote = makeAnnotation('way/1', [
  entry('alpine-ski', ['winter']),
  entry('mountain-bike', ['summer']),
]);
const lift = makeArea('way/2', 'lift');
const liftNote = makeAnnotation('way/2', [entry('lift-ride', [])]);
const plain = makeArea('way/3', 'nordic-trail');

describe('matchesFilter', () => {
  it('shows everything when no filter is active', () => {
    expect(matchesFilter(twoEntryArea, twoEntryNote, EMPTY_FILTER)).toBe(true);
    expect(matchesFilter(plain, undefined, EMPTY_FILTER)).toBe(true);
  });

  it('matches per entry, not per set union', () => {
    const m = (f: Filter) => matchesFilter(twoEntryArea, twoEntryNote, f);
    expect(m(filterOf(['mountain-bike']))).toBe(true);
    expect(m(filterOf([], ['winter']))).toBe(true);
    expect(m(filterOf(['mountain-bike'], ['summer']))).toBe(true);
    expect(m(filterOf(['mountain-bike'], ['winter']))).toBe(false);
  });

  it('keeps lifts visible under any filter, including a lift entry with seasons []', () => {
    expect(matchesFilter(lift, liftNote, filterOf(['nordic-classic']))).toBe(true);
    expect(matchesFilter(lift, liftNote, filterOf([], ['winter']))).toBe(true);
    expect(matchesFilter(lift, liftNote, filterOf(['nordic-classic'], ['winter']))).toBe(true);
    expect(matchesFilter(lift, undefined, filterOf([], ['winter']))).toBe(true);
  });

  it('hides unannotated and empty-activities areas while filtered, shows them otherwise', () => {
    const emptyNote = makeAnnotation('way/3', []);
    expect(matchesFilter(plain, undefined, filterOf([], ['winter']))).toBe(false);
    expect(matchesFilter(plain, emptyNote, filterOf([], ['winter']))).toBe(false);
    expect(matchesFilter(plain, undefined, EMPTY_FILTER)).toBe(true);
    expect(matchesFilter(plain, emptyNote, EMPTY_FILTER)).toBe(true);
  });

  it('lets an entry with seasons [] match activity-only but not season filters', () => {
    const blank = makeAnnotation('way/3', [entry('nordic-classic', [])]);
    expect(matchesFilter(plain, blank, filterOf(['nordic-classic']))).toBe(true);
    expect(matchesFilter(plain, blank, filterOf([], ['winter']))).toBe(false);
    expect(matchesFilter(plain, blank, filterOf(['nordic-classic'], ['winter']))).toBe(false);
  });
});

describe('facetCounts', () => {
  const mk = (id: string, kind: string): Area =>
    ({
      id,
      kind,
      name: null,
      difficulty: null,
      osmTags: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0, 0],
          [1, 1, 0],
        ],
      },
    }) as unknown as Area;
  const areas = [mk('way/1', 'downhill-run'), mk('way/2', 'mtb-trail'), mk('way/3', 'lift')];
  const ann = new Map<string, Annotation>([
    [
      'way/1',
      {
        areaId: 'way/1',
        activities: [{ activity: 'alpine-ski', seasons: ['winter'], notes: '' }],
        stakeholders: [],
        notes: '',
      },
    ],
    [
      'way/2',
      {
        areaId: 'way/2',
        activities: [{ activity: 'mountain-bike', seasons: ['summer', 'fall'], notes: '' }],
        stakeholders: [],
        notes: '',
      },
    ],
  ]);
  it('counts per option excluding lifts and reports zero for options with no data', async () => {
    const { facetCounts, EMPTY_FILTER } = await import('../../src/ui/filter-predicate');
    const c = facetCounts(
      areas,
      ann,
      EMPTY_FILTER,
      ['alpine-ski', 'mountain-bike', 'hike'],
      ['winter', 'summer', 'spring'],
    );
    expect(c.candidates).toBe(2);
    expect(c.lifts).toBe(1);
    expect(c.matching).toBe(2);
    expect(c.activities.get('alpine-ski')).toBe(1);
    expect(c.activities.get('hike')).toBe(0);
    expect(c.seasons.get('summer')).toBe(1);
    expect(c.seasons.get('spring')).toBe(0);
  });
  it('narrows counts under an active filter', async () => {
    const { facetCounts } = await import('../../src/ui/filter-predicate');
    const f = {
      activities: new Set(['alpine-ski'] as const),
      seasons: new Set<'winter' | 'summer'>(),
    };
    const c = facetCounts(
      areas,
      ann,
      f as never,
      ['alpine-ski', 'mountain-bike'],
      ['winter', 'summer'],
    );
    expect(c.matching).toBe(1);
    expect(c.seasons.get('winter')).toBe(1);
    expect(c.seasons.get('summer')).toBe(0);
  });
});

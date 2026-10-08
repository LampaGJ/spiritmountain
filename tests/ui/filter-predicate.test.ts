import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  matchesFilter,
  type Activity,
  type Filter,
  type Season,
} from '../../src/ui/filter-predicate';
import { entry, makeAnnotation, makeArea } from './filter-fixtures';
import { trackKey } from '../../src/scene/track-key';
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

describe('track counts (#50)', () => {
  const named = (id: string, kind: Area['kind'], name: string | null, tags = {}): Area =>
    ({ ...makeArea(id, kind), name, osmTags: tags }) as Area;
  const split = [
    named('way/1', 'hiking-trail', 'Superior Hiking Trail'),
    named('way/2', 'hiking-trail', 'Superior Hiking Trail'),
    named('way/3', 'hiking-trail', null, { 'route:name': 'Superior Hiking Trail' }),
    named('way/4', 'mtb-trail', 'Stone Age'),
    named('way/5', 'mtb-trail', null),
    named('way/6', 'mtb-trail', null),
    named('way/7', 'lift', 'Chair'),
  ];
  const notes = new Map<string, Annotation>([
    ['way/1', makeAnnotation('way/1', [entry('hike', ['summer'])])],
    ['way/2', makeAnnotation('way/2', [entry('hike', ['summer'])])],
    ['way/3', makeAnnotation('way/3', [entry('hike', ['summer'])])],
    ['way/4', makeAnnotation('way/4', [entry('mountain-bike', ['summer'])])],
    ['way/5', makeAnnotation('way/5', [entry('mountain-bike', ['summer'])])],
    ['way/6', makeAnnotation('way/6', [entry('mountain-bike', ['summer'])])],
  ]);

  it('keys a track by kind plus name, route:name or id', () => {
    expect(trackKey(split[0] as Area)).toBe(trackKey(split[1] as Area));
    expect(trackKey(split[2] as Area)).toBe(trackKey(split[0] as Area));
    expect(trackKey(split[4] as Area)).not.toBe(trackKey(split[5] as Area));
    expect(trackKey(named('way/9', 'mtb-trail', 'Chair'))).not.toBe(
      trackKey(named('way/9', 'lift', 'Chair')),
    );
  });

  it('counts a split track once per option, with unnamed segments as their own tracks', async () => {
    const { facetCounts } = await import('../../src/ui/filter-predicate');
    const c = facetCounts(split, notes, EMPTY_FILTER, ['hike', 'mountain-bike'], ['summer']);
    expect(c.activities.get('hike')).toBe(1);
    expect(c.activities.get('mountain-bike')).toBe(3);
    expect(c.seasons.get('summer')).toBe(4);
    expect(c.candidates).toBe(4);
    expect(c.matching).toBe(4);
    expect(c.lifts).toBe(1);
  });

  it('counts a split track once in the season badges', async () => {
    const { seasonCounts } = await import('../../src/ui/filter-predicate');
    const c = seasonCounts(split, notes);
    expect(c.seasons.get('summer')).toBe(4);
    expect(c.activities.get('summer')?.get('hike')).toBe(1);
  });
});

describe('seasonActivities and seasonCounts (#42)', () => {
  const notes = new Map<string, Annotation>([
    // Listed out of schema order on purpose: the output follows ActivitySchema.options.
    [
      'way/10',
      makeAnnotation('way/10', [
        entry('nordic-skate', ['winter']),
        entry('nordic-classic', ['winter']),
      ]),
    ],
    [
      'way/11',
      makeAnnotation('way/11', [
        entry('alpine-ski', ['winter']),
        entry('nordic-classic', ['winter']),
      ]),
    ],
    ['way/12', makeAnnotation('way/12', [entry('mountain-bike', ['summer', 'fall'])])],
    ['way/13', makeAnnotation('way/13', [entry('lift-ride', ['winter', 'summer'])])],
  ]);
  const seasonAreas: Area[] = [
    makeArea('way/10', 'nordic-trail'),
    makeArea('way/11', 'downhill-run'),
    makeArea('way/12', 'mtb-trail'),
    makeArea('way/13', 'lift'),
  ];

  it('keys every season, maps an empty season to [], excludes lift-ride and follows schema order', async () => {
    const { seasonActivities } = await import('../../src/ui/filter-predicate');
    const map = seasonActivities(notes);
    expect([...map.keys()]).toEqual(['winter', 'spring', 'summer', 'fall']);
    expect(map.get('spring')).toEqual([]);
    expect(map.get('winter')).toEqual(['alpine-ski', 'nordic-classic', 'nordic-skate']);
    expect(map.get('summer')).toEqual(['mountain-bike']);
    expect(map.get('fall')).toEqual(['mountain-bike']);
    for (const list of map.values()) expect(list).not.toContain('lift-ride');
  });

  it('counts non-lift areas per season and per activity in a season, differing by activity', async () => {
    const { seasonCounts } = await import('../../src/ui/filter-predicate');
    const c = seasonCounts(seasonAreas, notes);
    expect(c.seasons.get('winter')).toBe(2);
    expect(c.seasons.get('summer')).toBe(1);
    expect(c.seasons.get('spring')).toBe(0);
    const winter = c.activities.get('winter');
    expect(winter?.get('nordic-classic')).toBe(2);
    expect(winter?.get('alpine-ski')).toBe(1);
    expect(winter?.get('nordic-skate')).toBe(1);
    expect(winter?.has('lift-ride')).toBe(false);
    expect(c.activities.get('spring')?.size).toBe(0);
  });
});

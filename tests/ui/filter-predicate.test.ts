import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  matchesFilter,
  type Activity,
  type Filter,
  type Season,
} from '../../src/ui/filter-predicate';
import { entry, makeAnnotation, makeArea } from './filter-fixtures';

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

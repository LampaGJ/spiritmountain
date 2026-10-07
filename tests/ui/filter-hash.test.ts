import { describe, expect, it } from 'vitest';
import { ActivitySchema, SeasonSchema } from '../../src/schema/annotation';
import { decodeHash, encodeHash, ignoredNotice, type HashFilter } from '../../src/ui/filter-hash';

function subsets<T>(items: readonly T[], maxSize: number): T[][] {
  const out: T[][] = [[]];
  for (const a of items) out.push([a]);
  if (maxSize >= 2) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) out.push([items[i] as T, items[j] as T]);
    }
  }
  return out;
}

describe('hash codec', () => {
  it('round trips every subset of size 0 to 2 for activity and season', () => {
    for (const activity of subsets(ActivitySchema.options, 2)) {
      for (const season of subsets(SeasonSchema.options, 2)) {
        const state: HashFilter = { activity, season };
        expect(decodeHash(encodeHash(state)).filter).toEqual(state);
      }
    }
  });

  it('is deterministic: insertion order does not matter, activity precedes season', () => {
    const a = encodeHash({ activity: ['nordic-skate', 'nordic-classic'], season: ['winter'] });
    const b = encodeHash({ activity: ['nordic-classic', 'nordic-skate'], season: ['winter'] });
    expect(a).toBe('#activity=nordic-classic,nordic-skate&season=winter');
    expect(b).toBe(a);
  });

  it('encodes the empty state as an empty string', () => {
    expect(encodeHash({ activity: [], season: [] })).toBe('');
  });

  it('drops a bad token, keeps good ones, and reports the notice', () => {
    const d = decodeHash('#activity=nordic-classic,foo&season=winter');
    expect(d.filter).toEqual({ activity: ['nordic-classic'], season: ['winter'] });
    expect(d.ignored).toEqual(['foo']);
    expect(ignoredNotice(decodeHash('#activity=foo').ignored)).toBe('ignored: foo');
    expect(ignoredNotice([])).toBeNull();
  });

  it('reports an empty value and does not fold case', () => {
    expect(ignoredNotice(decodeHash('#activity=').ignored)).toBe('ignored: (empty)');
    const d = decodeHash('#activity=Nordic-Classic');
    expect(d.filter.activity).toEqual([]);
    expect(d.ignored).toEqual(['Nordic-Classic']);
  });

  it('merges duplicated keys, dedupes repeated values, and reads %2C as a comma', () => {
    expect(decodeHash('#activity=hike&activity=trail-run,hike').filter.activity).toEqual([
      'hike',
      'trail-run',
    ]);
    expect(decodeHash('#activity=hike%2Ctrail-run').filter.activity).toEqual(['hike', 'trail-run']);
  });

  it('ignores unknown keys, reports them in the notice, and never re-emits them', () => {
    const d = decodeHash('#view=top&activity=hike&x=1');
    expect(d.filter).toEqual({ activity: ['hike'], season: [] });
    expect(d.ignored).toEqual(['view=top', 'x=1']);
    expect(ignoredNotice(d.ignored)).toBe('ignored: view=top, x=1');
    expect(encodeHash(d.filter)).toBe('#activity=hike');
  });
});

describe('imagery key', () => {
  it('encodes imagery=off last and nothing when imagery is on or absent', () => {
    expect(encodeHash({ activity: [], season: [], imagery: false })).toBe('#imagery=off');
    expect(encodeHash({ activity: ['hike'], season: ['winter'], imagery: false })).toBe(
      '#activity=hike&season=winter&imagery=off',
    );
    expect(encodeHash({ activity: [], season: [], imagery: true })).toBe('');
    expect(encodeHash({ activity: [], season: [] })).toBe('');
  });

  it('round trips every subset with imagery off', () => {
    for (const activity of subsets(ActivitySchema.options, 2)) {
      for (const season of subsets(SeasonSchema.options, 2)) {
        const state: HashFilter = { activity, season, imagery: false };
        expect(decodeHash(encodeHash(state)).filter).toEqual(state);
      }
    }
  });

  it('decodes off to false, absent to undefined, and accepts on silently as the default', () => {
    expect(decodeHash('#imagery=off').filter.imagery).toBe(false);
    expect(decodeHash('').filter.imagery).toBeUndefined();
    const on = decodeHash('#imagery=on');
    expect(on.filter.imagery).toBeUndefined();
    expect(on.ignored).toEqual([]);
  });

  it('drops a bad token, reports the whole pair, and leaves imagery on', () => {
    const d = decodeHash('#imagery=maybe&activity=hike');
    expect(d.filter.imagery).toBeUndefined();
    expect(d.ignored).toEqual(['imagery=maybe']);
    expect(decodeHash('#imagery=OFF').ignored).toEqual(['imagery=OFF']);
    expect(decodeHash('#imagery').ignored).toEqual(['imagery']);
  });
});

describe('buildings key', () => {
  it('encodes buildings=off after imagery and nothing when on or absent', () => {
    expect(encodeHash({ activity: [], season: [], buildings: false })).toBe('#buildings=off');
    expect(encodeHash({ activity: [], season: [], imagery: false, buildings: false })).toBe(
      '#imagery=off&buildings=off',
    );
    expect(encodeHash({ activity: [], season: [], buildings: true })).toBe('');
  });

  it('round trips with buildings off', () => {
    const state: HashFilter = { activity: ['hike'], season: ['winter'], buildings: false };
    expect(decodeHash(encodeHash(state)).filter).toEqual(state);
  });

  it('decodes off to false, absent and on to undefined, and reports a bad token', () => {
    expect(decodeHash('#buildings=off').filter.buildings).toBe(false);
    expect(decodeHash('').filter.buildings).toBeUndefined();
    const on = decodeHash('#buildings=on');
    expect(on.filter.buildings).toBeUndefined();
    expect(on.ignored).toEqual([]);
    expect(decodeHash('#buildings=maybe').ignored).toEqual(['buildings=maybe']);
  });
});

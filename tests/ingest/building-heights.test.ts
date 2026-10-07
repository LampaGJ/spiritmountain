import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEIGHT_M,
  TYPE_HEIGHTS_M,
  heightOf,
  kindOf,
  parseHeightMetres,
  parseLevels,
} from '../../scripts/ingest/building-heights';

describe('heightOf: type table', () => {
  it('assigns 7 m to detached, house and semidetached_house', () => {
    for (const building of ['detached', 'house', 'semidetached_house'])
      expect(heightOf({ building })).toEqual({ heightM: 7, levels: null, source: 'type-table' });
  });

  it('assigns the table height for every listed kind', () => {
    const expected: Record<string, number> = {
      garage: 3.5,
      shed: 3.5,
      roof: 3.5,
      garages: 3.5,
      commercial: 8,
      retail: 8,
      apartments: 8,
      yes: 8,
      church: 12,
    };
    for (const [building, heightM] of Object.entries(expected))
      expect(heightOf({ building }).heightM, building).toBe(heightM);
    expect(heightOf({ man_made: 'tower' }).heightM).toBe(20);
    expect(heightOf({ man_made: 'mast' }).heightM).toBe(20);
    expect(heightOf({ man_made: 'water_tower' }).heightM).toBe(15);
    expect(heightOf({ man_made: 'storage_tank' }).heightM).toBe(6);
  });

  it('falls back to 6 m for an unlisted kind and still names the source', () => {
    expect(heightOf({ building: 'barn' })).toEqual({
      heightM: DEFAULT_HEIGHT_M,
      levels: null,
      source: 'type-table',
    });
    expect(DEFAULT_HEIGHT_M).toBe(6);
  });

  it('the table has the nine building and man_made rows the issue lists plus the aliases', () => {
    expect(Object.keys(TYPE_HEIGHTS_M).sort()).toEqual(
      [
        'apartments',
        'church',
        'commercial',
        'detached',
        'garage',
        'garages',
        'house',
        'mast',
        'retail',
        'roof',
        'semidetached_house',
        'shed',
        'storage_tank',
        'tower',
        'water_tower',
        'yes',
      ].sort(),
    );
  });
});

describe('heightOf: levels and height tags', () => {
  it('uses building:levels x 3 when present, ahead of the table', () => {
    expect(heightOf({ building: 'detached', 'building:levels': '2' })).toEqual({
      heightM: 6,
      levels: 2,
      source: 'levels',
    });
    expect(heightOf({ building: 'retail', 'building:levels': '1' }).heightM).toBe(3);
  });

  it('prefers the height tag over levels, stripping units', () => {
    expect(heightOf({ building: 'yes', height: '12 m', 'building:levels': '2' })).toEqual({
      heightM: 12,
      levels: 2,
      source: 'height',
    });
    expect(heightOf({ building: 'yes', height: '9.5m' }).heightM).toBe(9.5);
    expect(heightOf({ building: 'yes', height: '30 ft' }).heightM).toBe(9.14);
  });

  it('ignores unusable values and falls through to the next rule', () => {
    expect(heightOf({ building: 'house', height: 'tall' }).source).toBe('type-table');
    expect(heightOf({ building: 'house', height: '0' }).source).toBe('type-table');
    expect(heightOf({ building: 'house', 'building:levels': '0' })).toMatchObject({
      levels: null,
      source: 'type-table',
    });
    expect(heightOf({ building: 'house', 'building:levels': '1.5' }).levels).toBeNull();
  });
});

describe('parsers and kindOf', () => {
  it('parseHeightMetres', () => {
    expect(parseHeightMetres('12')).toBe(12);
    expect(parseHeightMetres(' 12.5 metres ')).toBe(12.5);
    expect(parseHeightMetres("10'")).toBe(3.05);
    expect(parseHeightMetres('-3')).toBeNull();
    expect(parseHeightMetres('12 m approx')).toBeNull();
    expect(parseHeightMetres(undefined)).toBeNull();
  });
  it('parseLevels', () => {
    expect(parseLevels('3')).toBe(3);
    expect(parseLevels('3;4')).toBeNull();
    expect(parseLevels(undefined)).toBeNull();
  });
  it('kindOf prefers building, then man_made, else null', () => {
    expect(kindOf({ building: 'yes', man_made: 'tower' })).toBe('yes');
    expect(kindOf({ man_made: 'tower' })).toBe('tower');
    expect(kindOf({ name: 'x' })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { obj, round2, writeJson } from '../../scripts/ingest/areas-serialize';
import { AreaFeatureCollectionSchema } from '../../src/schema/area';

describe('writeJson', () => {
  it('keeps the given key order, even for integer-like keys, and ends with exactly one LF', () => {
    const text = writeJson(
      obj([
        ['b', 1],
        ['10', 2],
        ['2', 3],
      ]),
    );
    expect(text).toBe('{\n  "b": 1,\n  "10": 2,\n  "2": 3\n}\n');
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text.includes('\r')).toBe(false);
  });

  it('writes number arrays on one line and other arrays one item per line', () => {
    expect(
      writeJson([
        [1, 2, 0],
        [3, 4, 0],
      ]),
    ).toBe('[\n  [1, 2, 0],\n  [3, 4, 0]\n]\n');
    expect(writeJson([])).toBe('[]\n');
    expect(writeJson(obj([]))).toBe('{}\n');
  });

  it('writes negative zero as 0 and rejects non-finite numbers by name', () => {
    expect(writeJson([-0, round2(-0.0004)])).toBe('[0, 0]\n');
    expect(() => writeJson(Number.POSITIVE_INFINITY)).toThrow(/NonFiniteNumber/);
    expect(() => writeJson(Number.NaN)).toThrow(/NonFiniteNumber/);
  });
});

describe('non-finite coordinates', () => {
  const feature = (x: number) => ({
    type: 'Feature' as const,
    properties: { id: 'way/1', kind: 'lift' as const, name: null, difficulty: null, osmTags: {} },
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [0, 0, 0],
        [x, 1, 0],
      ] as Array<[number, number, number]>,
    },
  });
  it('is rejected by the emitter gate (AreaFeatureCollectionSchema uses v4 z.number())', () => {
    expect(
      AreaFeatureCollectionSchema.safeParse({
        type: 'FeatureCollection',
        features: [feature(Number.POSITIVE_INFINITY)],
      }).success,
    ).toBe(false);
    expect(
      AreaFeatureCollectionSchema.safeParse({ type: 'FeatureCollection', features: [feature(5)] })
        .success,
    ).toBe(true);
  });
});

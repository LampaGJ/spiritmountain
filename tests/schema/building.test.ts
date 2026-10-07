import { describe, expect, it } from 'vitest';
import {
  BuildingFeatureCollectionSchema,
  BuildingFeatureSchema,
  BuildingIdSchema,
  BuildingSchema,
} from '../../src/schema/building';

export const validBuilding = {
  id: 'way/123',
  kind: 'detached',
  name: null,
  heightM: 7,
  levels: null,
  source: 'type-table',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 8, 0],
        [0, 0, 0],
      ],
    ],
  },
  osmTags: { building: 'detached' },
};

const feature = (b: typeof validBuilding) => {
  const { geometry, ...properties } = b;
  return { type: 'Feature', properties, geometry };
};

describe('BuildingSchema', () => {
  it('accepts a valid building', () => {
    expect(BuildingSchema.parse(validBuilding).heightM).toBe(7);
  });

  it('rejects a renamed field, naming it', () => {
    const { heightM, ...rest } = validBuilding;
    const result = BuildingSchema.safeParse({ ...rest, height: heightM });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.some((i) => i.path.join('.') === 'heightM')).toBe(true);
    expect(issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects an open ring', () => {
    const open = structuredClone(validBuilding);
    open.geometry.coordinates[0] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 8, 0],
      [0, 8, 0],
    ];
    const result = BuildingSchema.safeParse(open);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/must be closed/);
  });

  it('rejects a non-positive height and an unknown source', () => {
    expect(BuildingSchema.safeParse({ ...validBuilding, heightM: 0 }).success).toBe(false);
    expect(BuildingSchema.safeParse({ ...validBuilding, source: 'guess' }).success).toBe(false);
  });
});

describe('BuildingIdSchema', () => {
  it('accepts way, relation and exploded ring ids and rejects others', () => {
    for (const id of ['way/1', 'relation/2', 'relation/2#0', 'relation/2#13'])
      expect(BuildingIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of ['node/1', 'way/', 'way/1#', 'way/1#a', '1'])
      expect(BuildingIdSchema.safeParse(id).success, id).toBe(false);
  });
});

describe('BuildingFeatureSchema and BuildingFeatureCollectionSchema', () => {
  it('rejects a top-level Feature id member', () => {
    expect(BuildingFeatureSchema.safeParse({ ...feature(validBuilding), id: 'x' }).success).toBe(
      false,
    );
  });

  it('accepts a collection, rejects an empty one and a duplicate id', () => {
    const f = feature(validBuilding);
    expect(
      BuildingFeatureCollectionSchema.safeParse({ type: 'FeatureCollection', features: [f] })
        .success,
    ).toBe(true);
    expect(
      BuildingFeatureCollectionSchema.safeParse({ type: 'FeatureCollection', features: [] })
        .success,
    ).toBe(false);
    const dup = BuildingFeatureCollectionSchema.safeParse({
      type: 'FeatureCollection',
      features: [f, f],
    });
    expect(dup.success).toBe(false);
    expect(dup.error?.issues[0]?.message).toBe('duplicate building id way/123');
  });
});

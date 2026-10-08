import { describe, expect, it } from 'vitest';
import { PlaceSchema, PlaceSeedSchema, PlacesSeedSchema } from '../../src/schema/places';

const seed = {
  id: 'grand-avenue-chalet',
  name: 'Grand Avenue Chalet',
  kind: 'chalet',
  lat: 46.7155,
  lon: -92.2058,
  radiusM: 200,
  anchor: null,
  sourceUrl: 'https://example.com/',
  verified: true,
  positionNote: 'test',
};

describe('PlaceSeedSchema', () => {
  it('accepts a coordinate row, an anchor row and an unplaced unverified row', () => {
    expect(PlaceSeedSchema.safeParse(seed).success).toBe(true);
    const anchored = {
      ...seed,
      lat: null,
      lon: null,
      anchor: { areaName: 'Summit Chair', at: 'top' },
    };
    expect(PlaceSeedSchema.safeParse(anchored).success).toBe(true);
    const unplaced = { ...seed, lat: null, lon: null, verified: false };
    expect(PlaceSeedSchema.safeParse(unplaced).success).toBe(true);
  });

  it('rejects verified true with no position, coordinates plus an anchor, and half a coordinate', () => {
    expect(PlaceSeedSchema.safeParse({ ...seed, lat: null, lon: null }).success).toBe(false);
    expect(PlaceSeedSchema.safeParse({ ...seed, anchor: { placeId: 'other' } }).success).toBe(
      false,
    );
    expect(PlaceSeedSchema.safeParse({ ...seed, lon: null }).success).toBe(false);
  });

  it('rejects an unknown key, a bad id, a non-http source and a missing source', () => {
    expect(PlaceSeedSchema.safeParse({ ...seed, extra: 1 }).success).toBe(false);
    expect(PlaceSeedSchema.safeParse({ ...seed, id: 'Not Kebab' }).success).toBe(false);
    expect(PlaceSeedSchema.safeParse({ ...seed, sourceUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(PlaceSeedSchema.safeParse({ ...seed, sourceUrl: '' }).success).toBe(false);
  });
});

describe('PlacesSeedSchema', () => {
  it('rejects a duplicate id and a placeId that names no row with coordinates', () => {
    expect(PlacesSeedSchema.safeParse([seed, seed]).success).toBe(false);
    const dangling = {
      ...seed,
      id: 'nordic',
      lat: null,
      lon: null,
      anchor: { placeId: 'missing' },
    };
    expect(PlacesSeedSchema.safeParse([seed, dangling]).success).toBe(false);
    const ok = {
      ...seed,
      id: 'nordic',
      lat: null,
      lon: null,
      anchor: { placeId: 'grand-avenue-chalet' },
    };
    expect(PlacesSeedSchema.safeParse([seed, ok]).success).toBe(true);
  });

  it('rejects an empty seed rather than accepting no places', () => {
    expect(PlacesSeedSchema.safeParse([]).success).toBe(false);
  });
});

describe('PlaceSchema', () => {
  const placed = {
    id: 'a',
    name: 'A',
    kind: 'peak',
    east: 1,
    north: 2,
    radiusM: 600,
    sourceUrl: 'https://example.com/',
    verified: true,
    positionNote: 'test',
    positionSource: 'coordinates',
  };

  it('accepts a verified placed place and an unverified unplaced one', () => {
    expect(PlaceSchema.safeParse(placed).success).toBe(true);
    const none = { ...placed, east: null, north: null, verified: false, positionSource: 'none' };
    expect(PlaceSchema.safeParse(none).success).toBe(true);
  });

  it('rejects a verified place without a position and a mismatched positionSource', () => {
    expect(
      PlaceSchema.safeParse({ ...placed, east: null, north: null, positionSource: 'none' }).success,
    ).toBe(false);
    expect(PlaceSchema.safeParse({ ...placed, positionSource: 'none' }).success).toBe(false);
    expect(PlaceSchema.safeParse({ ...placed, north: null }).success).toBe(false);
  });
});

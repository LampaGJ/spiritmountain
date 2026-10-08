import { describe, expect, it } from 'vitest';
import {
  AreaFeatureCollectionSchema,
  AreaFeatureSchema,
  AreaGeometrySchema,
  AreaIdSchema,
  AreaKindSchema,
  AreaSchema,
  PolygonGeometrySchema,
} from '../../src/schema/area';
import {
  renameKey,
  validArea,
  validFeature,
  validFeatureCollection,
  validLine,
  validPolygon,
  withExtraKey,
} from './fixtures';

describe('AreaSchema', () => {
  it('parses a valid area with null name and difficulty', () => {
    expect(AreaSchema.safeParse(validArea).success).toBe(true);
  });
  it('rejects a renamed field', () => {
    expect(AreaSchema.safeParse(renameKey(validArea, 'kind', 'category')).success).toBe(false);
  });
  it('rejects an extra unknown key', () => {
    expect(AreaSchema.safeParse(withExtraKey(validArea)).success).toBe(false);
  });
  it('accepts exactly the twelve kinds', () => {
    expect(AreaKindSchema.options).toEqual([
      'downhill-run',
      'nordic-trail',
      'mtb-trail',
      'lift',
      'snow-park',
      'mtb-route',
      'hiking-trail',
      'tubing-run',
      'zip-line',
      'campground',
      'climbing',
      'attraction',
    ]);
  });
  it('rejects a numeric osmTags value', () => {
    expect(AreaSchema.safeParse({ ...validArea, osmTags: { lanes: 2 } }).success).toBe(false);
  });
  it('rejects a malformed id', () => {
    expect(AreaIdSchema.safeParse('way/').success).toBe(false);
    expect(AreaIdSchema.safeParse('way/123').success).toBe(true);
    expect(AreaIdSchema.safeParse('derived/tubing-run/way/123').success).toBe(true);
    expect(AreaIdSchema.safeParse('derived/tubing-run/').success).toBe(false);
    expect(AreaIdSchema.safeParse('derived/other/way/123').success).toBe(false);
  });
});

describe('AreaGeometrySchema', () => {
  it('parses a LineString and a Polygon', () => {
    expect(AreaGeometrySchema.safeParse(validLine).success).toBe(true);
    expect(AreaGeometrySchema.safeParse(validPolygon).success).toBe(true);
  });
  it('rejects a Point', () => {
    expect(AreaGeometrySchema.safeParse({ type: 'Point', coordinates: [0, 0, 0] }).success).toBe(
      false,
    );
  });
  it('rejects a two-element position', () => {
    expect(
      AreaGeometrySchema.safeParse({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects a two-element position inside a polygon ring', () => {
    const ring = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 0],
    ];
    expect(AreaGeometrySchema.safeParse({ type: 'Polygon', coordinates: [ring] }).success).toBe(
      false,
    );
  });
  it('rejects a one-position LineString', () => {
    expect(
      AreaGeometrySchema.safeParse({ type: 'LineString', coordinates: [[0, 0, 0]] }).success,
    ).toBe(false);
  });
  it('rejects a three-position ring', () => {
    const ring = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 0, 0],
    ];
    expect(PolygonGeometrySchema.safeParse({ type: 'Polygon', coordinates: [ring] }).success).toBe(
      false,
    );
  });
  it('rejects an open ring', () => {
    const ring = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 4, 0],
      [0, 4, 0],
    ];
    expect(PolygonGeometrySchema.safeParse({ type: 'Polygon', coordinates: [ring] }).success).toBe(
      false,
    );
  });
  it('rejects a non-finite coordinate', () => {
    expect(
      AreaGeometrySchema.safeParse({
        type: 'LineString',
        coordinates: [
          [0, 0, 0],
          [Infinity, 0, 0],
        ],
      }).success,
    ).toBe(false);
  });
});

describe('AreaFeatureSchema and AreaFeatureCollectionSchema', () => {
  it('parses a valid feature and collection', () => {
    expect(AreaFeatureSchema.safeParse(validFeature).success).toBe(true);
    expect(AreaFeatureCollectionSchema.safeParse(validFeatureCollection).success).toBe(true);
  });
  it('rejects a renamed field on the feature', () => {
    expect(
      AreaFeatureSchema.safeParse(renameKey(validFeature, 'properties', 'props')).success,
    ).toBe(false);
  });
  it('rejects a top-level Feature id member', () => {
    expect(AreaFeatureSchema.safeParse({ ...validFeature, id: 'way/123' }).success).toBe(false);
  });
  it('rejects an empty collection', () => {
    expect(
      AreaFeatureCollectionSchema.safeParse({ type: 'FeatureCollection', features: [] }).success,
    ).toBe(false);
  });
  it('rejects a renamed field on the collection', () => {
    expect(
      AreaFeatureCollectionSchema.safeParse(renameKey(validFeatureCollection, 'features', 'items'))
        .success,
    ).toBe(false);
  });
  it('rejects duplicate properties.id values', () => {
    const dup = { type: 'FeatureCollection', features: [validFeature, validFeature] };
    expect(AreaFeatureCollectionSchema.safeParse(dup).success).toBe(false);
  });
});

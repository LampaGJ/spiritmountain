import { describe, expect, it } from 'vitest';
import { GEOMETRY_RULE, mapKind, POINT_PROMOTED_KINDS } from '../../scripts/ingest/kind-mapping';

describe('mapKind: zip line, campground, climbing, attraction (#71)', () => {
  it.each([
    [{ aerialway: 'zip_line', name: 'Zip' }, 'zip-line'],
    [{ tourism: 'camp_site', name: 'Spirit Mountain Campsite' }, 'campground'],
    [{ sport: 'climbing' }, 'climbing'],
    [{ climbing: 'boulder' }, 'climbing'],
    [{ roller_coaster: 'track', name: 'Timber Twister Alpine Coaster' }, 'attraction'],
    [{ attraction: 'summer_toboggan' }, 'attraction'],
  ])('maps %j to %s with no difficulty', (tags, kind) => {
    expect(mapKind(tags)).toEqual({ ok: true, kind, difficulty: null });
  });

  it('keeps a lift a lift and does not take a zoo exhibit or the river train for a ride', () => {
    expect(mapKind({ aerialway: 'chair_lift' })).toMatchObject({ kind: 'lift' });
    expect(mapKind({ attraction: 'animal', name: 'Red Panda' })).toEqual({
      ok: false,
      reason: 'unmapped-tags',
      detail: 'attraction=animal',
    });
    expect(mapKind({ attraction: 'train' })).toMatchObject({ ok: false });
  });

  it('applies the new rules after route=hiking, so existing kinds keep their precedence', () => {
    expect(mapKind({ route: 'hiking', tourism: 'camp_site' })).toMatchObject({
      kind: 'hiking-trail',
    });
    expect(mapKind({ 'mtb:scale': '1', sport: 'climbing' })).toMatchObject({ kind: 'mtb-trail' });
  });

  it('declares which kinds are polygon-only, line-only and point-promotable', () => {
    expect(GEOMETRY_RULE['zip-line']).toBe('LineString');
    expect(GEOMETRY_RULE['campground']).toBe('Polygon');
    expect(GEOMETRY_RULE['climbing']).toBe('Polygon');
    expect(GEOMETRY_RULE['attraction']).toBe('either');
    expect(POINT_PROMOTED_KINDS).toEqual(['campground', 'climbing']);
  });
});

describe('mapKind', () => {
  it.each([
    [{ 'piste:type': 'downhill', 'piste:difficulty': 'easy' }, 'downhill-run', 'easy'],
    [{ 'piste:type': 'snow_park' }, 'snow-park', null],
    [{ 'piste:type': 'nordic', highway: 'path' }, 'nordic-trail', null],
    [{ aerialway: 'magic_carpet' }, 'lift', null],
    [{ 'mtb:scale': '3', highway: 'path' }, 'mtb-trail', '3'],
    [{ route: 'mtb' }, 'mtb-route', null],
    [{ route: 'hiking', name: 'Superior Hiking Trail' }, 'hiking-trail', null],
  ])('maps %j to %s with difficulty %s', (tags, kind, difficulty) => {
    expect(mapKind(tags)).toEqual({ ok: true, kind, difficulty });
  });

  it('applies the precedence piste:type, aerialway, mtb:scale, route=mtb', () => {
    expect(
      mapKind({ 'piste:type': 'nordic', 'mtb:scale': '1', aerialway: 'drag_lift' }),
    ).toMatchObject({ kind: 'nordic-trail' });
    expect(mapKind({ aerialway: 'drag_lift', 'mtb:scale': '1' })).toMatchObject({ kind: 'lift' });
    expect(mapKind({ 'mtb:scale': '1', route: 'mtb' })).toMatchObject({ kind: 'mtb-trail' });
    expect(mapKind({ 'piste:type': 'sled', aerialway: 'drag_lift' })).toMatchObject({
      kind: 'lift',
    });
  });

  it('never maps a pylon to a lift and reports the offending value for unmapped tags', () => {
    expect(mapKind({ aerialway: 'pylon' })).toEqual({
      ok: false,
      reason: 'unmapped-tags',
      detail: 'aerialway=pylon',
    });
    expect(mapKind({ 'piste:type': 'sled' })).toEqual({
      ok: false,
      reason: 'unmapped-piste-type',
      detail: 'piste:type=sled',
    });
    expect(mapKind({ highway: 'path' })).toEqual({
      ok: false,
      reason: 'unmapped-tags',
      detail: 'no-recognised-tag',
    });
  });
});

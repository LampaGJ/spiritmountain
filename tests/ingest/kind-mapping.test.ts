import { describe, expect, it } from 'vitest';
import { mapKind } from '../../scripts/ingest/kind-mapping';

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

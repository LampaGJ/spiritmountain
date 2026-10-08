import { describe, expect, it } from 'vitest';
import {
  drawSign,
  placeNameFor,
  planSigns,
  planTrailSigns,
  signTextureKey,
  type SignContext2D,
} from '../../src/scene/billboards';
import type { Area } from '../../src/schema/area';
import type { Place } from '../../src/schema/places';

const place = (over: Partial<Place> & Pick<Place, 'id' | 'name'>): Place => ({
  kind: 'chalet',
  east: 0,
  north: 0,
  radiusM: 200,
  sourceUrl: 'https://example.com/',
  verified: true,
  positionNote: 'test',
  positionSource: 'coordinates',
  ...over,
});

const seg = (id: string, name: string, coords: ReadonlyArray<readonly [number, number]>): Area =>
  ({
    id,
    kind: 'hiking-trail',
    name,
    difficulty: null,
    osmTags: {},
    geometry: { type: 'LineString', coordinates: coords.map(([e, n]) => [e, n, 0]) },
  }) as unknown as Area;

const two = (): Area[] => [
  seg('way/1', 'A', [
    [0, 0],
    [100, 0],
  ]),
  seg('way/2', 'B', [
    [0, 10],
    [100, 10],
  ]),
];
const ids = (areas: readonly Area[]): Set<string> => new Set(areas.map((a) => a.id));

describe('placeNameFor', () => {
  const point = { east: 100, north: 0 };

  it('returns the nearest verified place whose radius reaches the point', () => {
    const places = [
      place({ id: 'far', name: 'Far', east: 190, north: 0 }),
      place({ id: 'near', name: 'Near', east: 130, north: 0 }),
    ];
    expect(placeNameFor(point, places)).toBe('Near');
  });

  it('counts the radius itself as inside and a metre more as outside', () => {
    expect(
      placeNameFor(point, [place({ id: 'a', name: 'A', east: 300, north: 0, radiusM: 200 })]),
    ).toBe('A');
    expect(
      placeNameFor(point, [place({ id: 'a', name: 'A', east: 301, north: 0, radiusM: 200 })]),
    ).toBeNull();
  });

  it('never uses a place with verified false, however close it is', () => {
    const places = [
      place({ id: 'unverified', name: 'Unverified', east: 100, north: 0, verified: false }),
      place({ id: 'verified', name: 'Verified', east: 180, north: 0 }),
    ];
    expect(placeNameFor(point, places)).toBe('Verified');
    expect(placeNameFor(point, [places[0] as Place])).toBeNull();
  });

  it('skips a place with no position', () => {
    const none = place({
      id: 'none',
      name: 'None',
      east: null,
      north: null,
      positionSource: 'none',
      verified: false,
    });
    expect(placeNameFor(point, [none])).toBeNull();
  });

  it('gives an equal distance to the earlier place in the list', () => {
    const places = [
      place({ id: 'first', name: 'First', east: 150, north: 0 }),
      place({ id: 'second', name: 'Second', east: 50, north: 0 }),
    ];
    expect(placeNameFor(point, places)).toBe('First');
  });

  it('returns null for an empty list', () => {
    expect(placeNameFor(point, [])).toBeNull();
  });
});

describe('planSigns with places', () => {
  it('carries the place name on a concentration sign and keeps the "N trails" label', () => {
    const areas = two();
    const plans = planSigns(areas, new Map(), new Set(), ids(areas), [
      place({ id: 'p', name: 'Test Chalet', east: 50, north: 5 }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.place).toBe('Test Chalet');
    expect(plans[0]?.label).toBe('2 trails');
  });

  it('has no place property when no place reaches the sign, or when the place is unverified', () => {
    const areas = two();
    const far = place({ id: 'p', name: 'Far', east: 5000, north: 5000 });
    const unverified = place({ id: 'q', name: 'Unverified', east: 50, north: 5, verified: false });
    for (const places of [[], [far], [unverified]]) {
      const plans = planSigns(areas, new Map(), new Set(), ids(areas), places);
      expect(plans[0] && 'place' in plans[0]).toBe(false);
    }
  });

  it('defaults to no places', () => {
    const areas = two();
    expect(planSigns(areas, new Map(), new Set(), ids(areas))[0]?.label).toBe('2 trails');
  });

  it('leaves trail signs without a place', () => {
    const areas = two();
    const plans = planTrailSigns(areas, new Map(), new Set(), ids(areas));
    expect(plans.every((p) => !('place' in p))).toBe(true);
  });
});

describe('sign texture and drawing with a place', () => {
  const key = (placeName?: string) =>
    signTextureKey({
      family: 'concentration',
      activities: ['hike'],
      label: '2 trails',
      place: placeName,
    });

  it('keys the texture on the place name', () => {
    expect(key('A')).not.toBe(key('B'));
    expect(key('A')).not.toBe(key());
  });

  it('draws the place name in bold first and the trail count smaller below it', () => {
    const calls: { op: string; text?: string; font: string; y?: number }[] = [];
    const ctx = {
      fillStyle: '',
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      clearRect() {},
      beginPath() {},
      moveTo() {},
      arc() {},
      arcTo() {},
      closePath() {},
      fill() {},
      fillText(text: string, _x: number, y: number) {
        calls.push({ op: 'fillText', text, font: ctx.font, y });
      },
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as unknown as SignContext2D;
    drawSign(ctx, {
      activities: ['hike'],
      label: '2 trails',
      family: 'concentration',
      place: 'Grand Avenue Chalet',
      glyph: false,
      width: 512,
      height: 128,
    });
    const name = calls.find((c) => c.text === 'Grand Avenue Chalet');
    const count = calls.find((c) => c.text === '2 trails');
    expect(name?.font).toMatch(/^bold /);
    expect(count?.font).not.toMatch(/^bold /);
    expect(name?.y).toBeLessThan(count?.y ?? 0);
    const size = (font: string | undefined) => Number(/(\d+)px/.exec(font ?? '')?.[1]);
    expect(size(name?.font)).toBeGreaterThan(size(count?.font));
  });
});

import { describe, expect, it } from 'vitest';
import {
  drawSign,
  CATCHMENT_M,
  PLACE_SIGN_KINDS,
  SPLIT_EXTENT_M,
  SPLIT_TRACKS,
  planSigns,
  planTrailSigns,
  signTextureKey,
  type SignContext2D,
} from '../../src/scene/billboards';
import type { Activity } from '../../src/scene/sport-routing';
import type { Annotation } from '../../src/schema/annotation';
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

const ids = (areas: readonly Area[]): Set<string> => new Set(areas.map((a) => a.id));

/** A horizontal track centred on east 0 at the given north, so its length-weighted centroid is exactly (0, north). */
const trackAt = (id: string, north: number, name = id): Area =>
  seg(id, name, [
    [-50, north],
    [50, north],
  ]);

const noteFor = (areaId: string, activities: Activity[]): Annotation =>
  ({
    areaId,
    activities: activities.map((activity) => ({ activity, seasons: [], notes: '' })),
    stakeholders: [],
    notes: '',
  }) as Annotation;

describe('planSigns with places (#61)', () => {
  const origin = (over: Partial<Place> = {}): Place =>
    place({ id: 'p', name: 'Test Chalet', east: 0, north: 0, ...over });
  const run = (areas: Area[], places: Place[], visible = ids(areas)) =>
    planSigns(areas, new Map(), new Set(), visible, places);

  it('uses a 900 m catchment, 8 tracks and 1000 m as the split limits', () => {
    expect(CATCHMENT_M).toBe(900);
    expect(SPLIT_TRACKS).toBe(8);
    expect(SPLIT_EXTENT_M).toBe(1000);
  });

  it('assigns a track at 899 m and at exactly 900 m, and leaves one at 901 m to the clusters', () => {
    for (const [distance, owned] of [
      [899, true],
      [900, true],
      [901, false],
    ] as const) {
      const areas = [trackAt('way/1', distance, 'Lone')];
      const plans = run(areas, [origin()]);
      expect(plans, `${distance} m`).toHaveLength(1);
      if (owned) {
        expect(plans[0]).toMatchObject({ place: 'Test Chalet', label: '1 trail', trackCount: 1 });
      } else {
        expect(plans[0]?.place).toBeUndefined();
        expect(plans[0]?.label).toBe('Lone');
      }
    }
  });

  it('puts the place sign at the place position with the union of its tracks sports and N trails', () => {
    const areas = [trackAt('way/1', 100), trackAt('way/2', 200), trackAt('way/3', 300)];
    const annotations = new Map([
      ['way/1', noteFor('way/1', ['hike'])],
      ['way/2', noteFor('way/2', ['mountain-bike'])],
      ['way/3', noteFor('way/3', ['hike'])],
    ]);
    const plans = planSigns(areas, annotations, new Set(), ids(areas), [
      origin({ east: 10, north: 20 }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      east: 10,
      north: 20,
      family: 'concentration',
      place: 'Test Chalet',
      label: '3 trails',
      trackCount: 3,
    });
    expect([...(plans[0]?.activities ?? [])].sort()).toEqual(['hike', 'mountain-bike']);
  });

  it('gives a track to the nearest place, whatever the order of the list', () => {
    const near = origin({ id: 'near', name: 'Near', north: 500 });
    const far = origin({ id: 'far', name: 'Far', north: 0 });
    const areas = [trackAt('way/1', 450)];
    expect(run(areas, [far, near]).map((p) => p.place)).toEqual(['Near']);
    expect(run(areas, [near, far]).map((p) => p.place)).toEqual(['Near']);
  });

  it('gives a tie to the earlier place and hides the later place, which has no tracks', () => {
    const first = origin({ id: 'first', name: 'First' });
    const second = origin({ id: 'second', name: 'Second' });
    const areas = [trackAt('way/1', 100)];
    expect(run(areas, [first, second]).map((p) => p.place)).toEqual(['First']);
    expect(run(areas, [second, first]).map((p) => p.place)).toEqual(['Second']);
  });

  it('shows no sign for a place with zero member tracks after the filter', () => {
    const areas = [trackAt('way/1', 100), trackAt('way/2', 200)];
    expect(run(areas, [origin()], new Set())).toEqual([]);
    const onlyTwo = run(areas, [origin()], new Set(['way/2']));
    expect(onlyTwo.map((p) => [p.place, p.trackCount])).toEqual([['Test Chalet', 1]]);
    const far = [trackAt('way/3', 5000)];
    expect(run(far, [origin()]).map((p) => p.place)).toEqual([undefined]);
  });

  it('never gives a track to an unverified place, an unplaced place, a lift top or a campground', () => {
    const areas = [trackAt('way/1', 100, 'Lone')];
    const blocked = [
      origin({ verified: false }),
      origin({ east: null, north: null, verified: false, positionSource: 'none' }),
      origin({ kind: 'lift-top' }),
      origin({ kind: 'campground' }),
    ];
    for (const b of blocked) {
      expect(run(areas, [b]).map((p) => p.place)).toEqual([undefined]);
    }
    expect([...PLACE_SIGN_KINDS].sort()).toEqual(
      ['adventure-park', 'chalet', 'nordic-centre', 'overlook', 'park-zone', 'peak'].sort(),
    );
  });

  it('still clusters the tracks no place owns, into a concentration with no place name', () => {
    const leftA = seg('way/10', 'LeftA', [
      [3000, 0],
      [3100, 0],
    ]);
    const leftB = seg('way/11', 'LeftB', [
      [3000, 100],
      [3100, 100],
    ]);
    const areas = [trackAt('way/1', 100), leftA, leftB];
    const plans = run(areas, [origin()]);
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.place === undefined)).toMatchObject({
      label: '2 trails',
      trackCount: 2,
    });
    expect(plans.find((p) => p.place !== undefined)?.trackCount).toBe(1);
  });

  it('splits a leftover concentration of more than 8 tracks over 1000 m, and not 8 tracks or less extent', () => {
    const rowOf = (count: number, spacing: number): Area[] =>
      Array.from({ length: count }, (_, i) =>
        seg(`way/${i}`, `T${i}`, [
          [i * spacing, 5000],
          [i * spacing, 5010],
        ]),
      );
    expect(run(rowOf(9, 130), [origin()])).toHaveLength(2);
    expect(run(rowOf(9, 100), [origin()])).toHaveLength(1);
    expect(run(rowOf(8, 200), [origin()])).toHaveLength(1);
  });

  it('defaults to no places', () => {
    const areas = [trackAt('way/1', 0), trackAt('way/2', 10)];
    expect(planSigns(areas, new Map(), new Set(), ids(areas))[0]?.label).toBe('2 trails');
  });

  it('leaves trail signs without a place', () => {
    const areas = [trackAt('way/1', 0), trackAt('way/2', 10)];
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
      lineTo() {},
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

  it('draws a short place name at 0.34 of the sign height in bold, the size of a trail name', () => {
    const fonts = new Map<string, string>();
    const make = (): SignContext2D => {
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
        lineTo() {},
        closePath() {},
        fill() {},
        fillText(text: string) {
          fonts.set(text, ctx.font);
        },
        measureText: (text: string) => ({ width: text.length * 5 }),
      };
      return ctx as unknown as SignContext2D;
    };
    const base = { glyph: false, width: 512, height: 128 };
    drawSign(make(), {
      ...base,
      activities: ['hike'],
      label: '3 trails',
      family: 'concentration',
      place: 'Peak',
    });
    const size = /^bold (\d+)px/.exec(fonts.get('Peak') ?? '')?.[1];
    expect(size).toBe(String(Math.round(128 * 0.34)));
    fonts.clear();
    drawSign(make(), { ...base, activities: ['hike'], label: 'Peak', family: 'trail' });
    expect(/^bold (\d+)px/.exec(fonts.get('Peak') ?? '')?.[1]).toBe(size);
    expect(fonts.get('3 trails')).toBeUndefined();
  });
});

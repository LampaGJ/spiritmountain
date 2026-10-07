import { describe, expect, it } from 'vitest';
import type { Area } from '../../src/schema/area';
import { deriveLandmarks, mainLift, upperChalet } from '../../src/scene/landmarks';

const lift = (id: string, aerialway: string, coordinates: number[][]): { area: Area } => ({
  area: {
    id,
    kind: 'lift',
    name: id,
    difficulty: null,
    osmTags: { aerialway },
    geometry: { type: 'LineString', coordinates },
  } as unknown as Area,
});
const building = (name: string | null, heightM: number, ring: number[][]) =>
  ({
    properties: { name, heightM },
    geometry: { type: 'Polygon' as const, coordinates: [ring] },
  }) as never;

// Terrain rises with north, so the lower end of a lift is its southern end.
const sample = (_east: number, north: number): number => north;
const ring = [
  [0, 0],
  [10, 0],
  [10, 20],
  [0, 20],
  [0, 0],
];

describe('mainLift', () => {
  const entries = [
    lift('way/1', 'chair_lift', [
      [0, 0, 0],
      [0, 100, 0],
    ]),
    lift('way/2', 'chair_lift', [
      [0, 0, 0],
      [300, 0, 0],
      [300, 400, 0],
    ]),
    lift('way/3', 'gondola', [
      [0, 0, 0],
      [0, 5000, 0],
    ]),
  ];
  it('picks the longest chair_lift and its lower end as the base', () => {
    expect(mainLift(entries, sample)).toEqual({
      base: { east: 0, north: 0 },
      top: { east: 300, north: 400 },
    });
  });
  it('flips base and top when the first vertex is the higher end', () => {
    const flipped = [
      lift('way/2', 'chair_lift', [
        [300, 400, 0],
        [0, 0, 0],
      ]),
    ];
    expect(mainLift(flipped, sample)?.base).toEqual({ east: 0, north: 0 });
  });
  it('is null without a chair_lift', () => {
    expect(
      mainLift(
        [
          lift('way/3', 'gondola', [
            [0, 0, 0],
            [0, 9, 0],
          ]),
        ],
        sample,
      ),
    ).toBeNull();
    expect(mainLift([], sample)).toBeNull();
  });
});

describe('upperChalet', () => {
  it('matches the name case-insensitively and returns the outer-ring centroid and roof height', () => {
    const found = upperChalet([
      building('Other', 3, ring),
      building('Spirit Mountain UPPER CHALET', 8, ring),
    ]);
    expect(found).toEqual({ east: 5, north: 10, roofM: 8 });
  });
  it('is null when no name matches or names are null', () => {
    expect(upperChalet([building(null, 3, ring), building('Lower Chalet', 3, ring)])).toBeNull();
  });
});

describe('deriveLandmarks', () => {
  const entries = [
    lift('way/2', 'chair_lift', [
      [300, 400, 0],
      [0, 0, 0],
    ]),
  ];
  it('combines lift and chalet', () => {
    expect(deriveLandmarks(entries, [building('Upper Chalet', 8, ring)], sample)).toEqual({
      liftBase: { east: 0, north: 0 },
      liftTop: { east: 300, north: 400 },
      upperChalet: { east: 5, north: 10, roofM: 8 },
    });
  });
  it('omits the chalet when buildings are absent, and is null without a lift', () => {
    expect(deriveLandmarks(entries, null, sample)?.upperChalet).toBeUndefined();
    expect(deriveLandmarks([], null, sample)).toBeNull();
  });
});

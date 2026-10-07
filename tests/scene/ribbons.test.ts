import { describe, expect, it } from 'vitest';
import { DRAPE_LIFT_M, type Vec2 } from '../../src/scene/drape';
import { createMeshSurface, type Heightfield, type MeshSurface } from '../../src/scene/heightfield';
import {
  buildRibbonGeometry,
  FootprintIndex,
  RIBBON_OPEN_WALL_M,
  RIBBON_SINK_M,
  type RibbonBuild,
  type RibbonSpec,
} from '../../src/scene/ribbons';

/** A 1 m grid over east -200..200, north -200..200 whose height is fn(east, north). */
function surfaceOf(fn: (east: number, north: number) => number): MeshSurface {
  const cols = 401;
  const rows = 401;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = fn(-200 + c, 200 - r);
  }
  const field: Heightfield = {
    cols,
    rows,
    originEast: -200,
    originNorth: 200,
    cellSizeEast: 1,
    cellSizeNorth: 1,
    data,
  };
  return createMeshSurface(field, 400);
}

const FLAT = surfaceOf(() => 0);
const toScene = (east: number, north: number, elevation: number): [number, number, number] => [
  east,
  elevation,
  -north,
];
const SPEC: RibbonSpec = { widthM: 4, periodM: 2, stepM: 4, edgeColor: '#c3d2e6' };
const STRAIGHT: Vec2[] = [
  [0, 0],
  [100, 0],
];
const BENT: Vec2[] = [
  [0, 0],
  [50, 0],
  [50, 50],
];

const build = (line: Vec2[], active: MeshSurface = FLAT, spec = SPEC): RibbonBuild => {
  const ribbon = buildRibbonGeometry([{ areaId: 'a', line }], spec, FLAT, toScene);
  ribbon.redrape(active, null);
  return ribbon;
};

function positions(ribbon: RibbonBuild): Float32Array {
  return ribbon.geometry.getAttribute('position').array as Float32Array;
}

describe('ribbon top strip', () => {
  it('a straight 100 m line of width 4 m has top vertices 2 m either side', () => {
    const ribbon = build(STRAIGHT);
    const range = ribbon.ranges[0]!;
    const p = positions(ribbon);
    const zs = new Set<number>();
    for (let i = 0; i < range.stations; i += 1) {
      for (let j = 0; j < range.columns; j += 1) {
        zs.add(p[(range.top + i * range.columns + j) * 3 + 2]!);
      }
    }
    expect(Math.min(...zs)).toBeCloseTo(-2, 6);
    expect(Math.max(...zs)).toBeCloseTo(2, 6);
  });

  it('u runs from 0 to length / period along the line, v from 0 to 1 across', () => {
    const ribbon = build(STRAIGHT);
    const range = ribbon.ranges[0]!;
    const uv = ribbon.geometry.getAttribute('uv').array as Float32Array;
    const first = range.top;
    const last = range.top + (range.stations - 1) * range.columns;
    expect(uv[first * 2]).toBeCloseTo(0, 6);
    expect(uv[last * 2]).toBeCloseTo(100 / SPEC.periodM, 5);
    expect(uv[first * 2 + 1]).toBeCloseTo(0, 6);
    expect(uv[(first + range.columns - 1) * 2 + 1]).toBeCloseTo(1, 6);
  });

  it('a bent line keeps its width: each edge vertex is 2 m from the line of both adjacent segments', () => {
    const ribbon = build(BENT);
    const range = ribbon.ranges[0]!;
    const p = positions(ribbon);
    const at = (i: number, j: number): [number, number] => {
      const k = (range.top + i * range.columns + j) * 3;
      return [p[k]!, -p[k + 2]!];
    };
    const distToLine = (pt: [number, number], a: Vec2, b: Vec2): number => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return Math.abs((b[0] - a[0]) * (a[1] - pt[1]) - (a[0] - pt[0]) * (b[1] - a[1])) / len;
    };
    for (let i = 0; i < range.stations; i += 1) {
      for (const j of [0, range.columns - 1]) {
        const pt = at(i, j);
        // Which segment(s) touch this station: the corner (50, 0) touches both.
        const centre: Vec2 = [
          (at(i, 0)[0] + at(i, range.columns - 1)[0]) / 2,
          (at(i, 0)[1] + at(i, range.columns - 1)[1]) / 2,
        ];
        const onFirst = Math.abs(centre[1]) < 1e-6 && centre[0] <= 50 + 1e-6;
        const onSecond = Math.abs(centre[0] - 50) < 1e-6 && centre[1] >= -1e-6;
        if (onFirst) expect(distToLine(pt, BENT[0]!, BENT[1]!)).toBeCloseTo(2, 5);
        if (onSecond) expect(distToLine(pt, BENT[1]!, BENT[2]!)).toBeCloseTo(2, 5);
        expect(onFirst || onSecond).toBe(true);
      }
    }
  });

  it('a 12 m wide ribbon has interior columns, so the top follows ground that curves across it', () => {
    const ribbon = build(STRAIGHT, FLAT, { ...SPEC, widthM: 12 });
    expect(ribbon.ranges[0]!.columns).toBeGreaterThan(2);
  });
});

describe('ribbon thickness', () => {
  const wallHeights = (ribbon: RibbonBuild): number[] => {
    const range = ribbon.ranges[0]!;
    const p = positions(ribbon);
    return Array.from({ length: range.stations }, (_, i) => {
      const top = (range.wallLeft + 2 * i) * 3 + 1;
      return p[top]! - p[top + 3]!;
    });
  };

  it('is 0.8 m in the open (0.5 m lift above ground, 0.3 m sunk below it)', () => {
    expect(RIBBON_OPEN_WALL_M).toBeCloseTo(DRAPE_LIFT_M + RIBBON_SINK_M, 9);
    for (const h of wallHeights(build(STRAIGHT))) expect(h).toBeCloseTo(0.8, 5);
  });

  it('rises to the canopy over a bump: wall height is the bump plus 0.8 m', () => {
    const canopy = surfaceOf((e, n) => (e >= 30 && e <= 70 && Math.abs(n) <= 20 ? 12 : 0));
    const ribbon = build(STRAIGHT, canopy);
    const range = ribbon.ranges[0]!;
    const heights = wallHeights(ribbon);
    let inside = 0;
    for (let i = 0; i < range.stations; i += 1) {
      const east = i * 4;
      if (east >= 32 && east <= 68) {
        expect(heights[i], `east ${east}`).toBeCloseTo(12 + 0.8, 4);
        inside += 1;
      }
      if (east <= 26 || east >= 74) expect(heights[i], `east ${east}`).toBeCloseTo(0.8, 4);
    }
    expect(inside).toBeGreaterThan(5);
  });

  it('keeps the base on bare earth minus 0.3 m even when the active surface is the canopy', () => {
    const canopy = surfaceOf(() => 12);
    const ribbon = build(STRAIGHT, canopy);
    const range = ribbon.ranges[0]!;
    const p = positions(ribbon);
    for (let i = 0; i < range.stations; i += 1) {
      expect(p[(range.wallLeft + 2 * i + 1) * 3 + 1]).toBeCloseTo(-RIBBON_SINK_M, 5);
    }
  });

  it('drapes the top on bare earth where the ribbon crosses a footprint (buildings are not pierced)', () => {
    const canopy = surfaceOf(() => 12);
    const footprints = new FootprintIndex([
      [
        [40, -10],
        [60, -10],
        [60, 10],
        [40, 10],
        [40, -10],
      ],
    ]);
    const ribbon = buildRibbonGeometry([{ areaId: 'a', line: STRAIGHT }], SPEC, FLAT, toScene);
    ribbon.redrape(canopy, footprints);
    const range = ribbon.ranges[0]!;
    const p = positions(ribbon);
    for (let i = 0; i < range.stations; i += 1) {
      const east = i * 4;
      const topY = p[(range.top + i * range.columns) * 3 + 1]!;
      if (east >= 44 && east <= 56) expect(topY, `east ${east}`).toBeCloseTo(DRAPE_LIFT_M, 5);
      if (east <= 30 || east >= 70) expect(topY, `east ${east}`).toBeCloseTo(12 + DRAPE_LIFT_M, 5);
    }
  });

  it('re-drapes the top when the active surface changes, in place', () => {
    const ribbon = build(STRAIGHT);
    const before = positions(ribbon);
    const sameBuffer = before;
    ribbon.redrape(
      surfaceOf(() => 5),
      null,
    );
    expect(positions(ribbon)).toBe(sameBuffer);
    const range = ribbon.ranges[0]!;
    expect(before[(range.top + 1) * 3 + 1]).toBeCloseTo(5 + DRAPE_LIFT_M, 5);
  });
});

/** Welds vertices by position and returns every triangle as three vertex keys. */
function weldedTriangles(ribbon: RibbonBuild): string[][] {
  const p = positions(ribbon);
  const index = ribbon.geometry.getIndex()!.array;
  const key = (v: number): string =>
    `${p[v * 3]!.toFixed(4)},${p[v * 3 + 1]!.toFixed(4)},${p[v * 3 + 2]!.toFixed(4)}`;
  const tris: string[][] = [];
  for (let t = 0; t < index.length; t += 3) {
    tris.push([key(index[t]!), key(index[t + 1]!), key(index[t + 2]!)]);
  }
  return tris;
}

/** Signed volume by the divergence theorem; positive when faces wind outward. */
function signedVolume(ribbon: RibbonBuild): number {
  const p = positions(ribbon);
  const index = ribbon.geometry.getIndex()!.array;
  let volume = 0;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t]!, index[t + 1]!, index[t + 2]!].map((v) => [
      p[v * 3]!,
      p[v * 3 + 1]!,
      p[v * 3 + 2]!,
    ]) as [number[], number[], number[]];
    volume +=
      (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
        a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) +
        a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) /
      6;
  }
  return volume;
}

describe.each([
  ['straight', STRAIGHT],
  ['bent', BENT],
])('ribbon volume, %s line', (_name, line) => {
  it('is watertight: every edge is shared by exactly two triangles', () => {
    const edges = new Map<string, number>();
    for (const [a, b, c] of weldedTriangles(build(line))) {
      for (const [from, to] of [
        [a!, b!],
        [b!, c!],
        [c!, a!],
      ] as const) {
        const key = from < to ? `${from}|${to}` : `${to}|${from}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect(edges.size).toBeGreaterThan(0);
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
  });

  it('is consistently oriented: every directed edge is used once, and the volume is positive', () => {
    const ribbon = build(line);
    const directed = new Map<string, number>();
    for (const [a, b, c] of weldedTriangles(ribbon)) {
      for (const [from, to] of [
        [a!, b!],
        [b!, c!],
        [c!, a!],
      ] as const) {
        directed.set(`${from}>${to}`, (directed.get(`${from}>${to}`) ?? 0) + 1);
      }
    }
    expect([...directed.values()].every((n) => n === 1)).toBe(true);
    expect(signedVolume(ribbon)).toBeGreaterThan(0);
  });
});

describe('ribbon volume size', () => {
  it('a straight 100 m by 4 m slab in the open encloses 100 x 4 x 0.8 m3', () => {
    expect(signedVolume(build(STRAIGHT))).toBeCloseTo(100 * 4 * 0.8, 2);
  });

  it('top normals point up and the geometry has two groups: top, then walls and ends', () => {
    const ribbon = build(STRAIGHT);
    const normals = ribbon.geometry.getAttribute('normal').array as Float32Array;
    const range = ribbon.ranges[0]!;
    expect(normals[(range.top + 1) * 3 + 1]).toBeGreaterThan(0.99);
    expect(ribbon.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(ribbon.triangleCount).toBe(ribbon.geometry.getIndex()!.count / 3);
  });
});

describe('FootprintIndex', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  it('contains a point inside and not one outside', () => {
    const index = new FootprintIndex([square]);
    expect(index.contains(5, 5)).toBe(true);
    expect(index.contains(15, 5)).toBe(false);
    expect(index.contains(-1, 5)).toBe(false);
  });
});

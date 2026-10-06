import { describe, expect, it } from 'vitest';
import {
  DRAPE_LIFT_M,
  LIFT_DEFAULT_OFFSET_M,
  LIFT_OFFSET_M,
  cableLine,
  densify,
  drapeLine,
  liftOffsetM,
  minClearance,
  splitAtMeshEdges,
  type Vec2,
} from '../../src/scene/drape';
import { createMeshSurface, type Heightfield } from '../../src/scene/heightfield';
import { makeFixtureField } from '../fixtures/make-field';

function rampField(fn: (east: number, north: number) => number): Heightfield {
  const cols = 21;
  const rows = 17;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = fn(c * 10, 160 - r * 10);
  }
  return { cols, rows, originEast: 0, originNorth: 160, cellSizeEast: 10, cellSizeNorth: 10, data };
}

describe('densify', () => {
  it('keeps endpoints and keeps every step at or under 10 m for a 35 m segment', () => {
    const out = densify([
      [0, 0],
      [35, 0],
    ]);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([35, 0]);
    for (let k = 1; k < out.length; k += 1) {
      const a = out[k - 1] as Vec2;
      const b = out[k] as Vec2;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(10 + 1e-9);
    }
    expect(out).toHaveLength(5);
  });

  it('splits an exact multiple into exact steps', () => {
    expect(
      densify([
        [0, 0],
        [20, 0],
      ]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it('adds nothing to a short segment and drops a zero-length segment', () => {
    expect(
      densify([
        [0, 0],
        [4, 3],
      ]),
    ).toEqual([
      [0, 0],
      [4, 3],
    ]);
    expect(
      densify([
        [1, 1],
        [1, 1],
        [5, 1],
      ]),
    ).toEqual([
      [1, 1],
      [5, 1],
    ]);
  });

  it('keeps original vertices of a polyline', () => {
    const out = densify([
      [0, 0],
      [25, 0],
      [25, 12],
    ]);
    expect(out).toContainEqual([25, 0]);
    expect(out[out.length - 1]).toEqual([25, 12]);
  });
});

describe('splitAtMeshEdges', () => {
  it('adds a point at every grid line and diagonal a segment crosses', () => {
    const surface = createMeshSurface(rampField(() => 0));
    // From (5, 155) to (35, 155): crosses u = 1, 2, 3 and the diagonals u + v = 1 + 0.5 offsets.
    const out = splitAtMeshEdges(surface, [
      [5, 155],
      [35, 155],
    ]);
    expect(out.length).toBeGreaterThan(4);
    expect(out[0]).toEqual([5, 155]);
    expect(out[out.length - 1]).toEqual([35, 155]);
  });

  it('adds nothing inside one triangle', () => {
    const surface = createMeshSurface(rampField(() => 0));
    expect(
      splitAtMeshEdges(surface, [
        [2, 157],
        [3, 156],
      ]),
    ).toEqual([
      [2, 157],
      [3, 156],
    ]);
  });
});

describe('drapeLine', () => {
  it('lies DRAPE_LIFT_M above a flat 120 m field', () => {
    const surface = createMeshSurface(rampField(() => 120));
    const { points, clampedCount } = drapeLine(surface, [
      [12, 140, 0],
      [143, 33, 0],
    ]);
    expect(clampedCount).toBe(0);
    for (const p of points) expect(p[2]).toBeCloseTo(120 + DRAPE_LIFT_M, 4);
  });

  it('follows a ramp in east and in north', () => {
    const east = createMeshSurface(rampField((e) => 2 * e));
    const a = drapeLine(east, [
      [12.5, 140, 0],
      [143, 33, 0],
    ]).points;
    for (const p of a) expect(p[2]).toBeCloseTo(2 * p[0] + DRAPE_LIFT_M, 3);
    const north = createMeshSurface(rampField((_e, n) => 3 * n));
    const b = drapeLine(north, [
      [12.5, 140, 0],
      [143, 33, 0],
    ]).points;
    for (const p of b) expect(p[2]).toBeCloseTo(3 * p[1] + DRAPE_LIFT_M, 3);
  });

  it('keeps every step at or under 10 m and keeps the endpoints', () => {
    const surface = createMeshSurface(rampField((e) => e));
    const { points } = drapeLine(surface, [
      [3, 150, 0],
      [188, 12, 0],
    ]);
    expect(points[0]?.slice(0, 2)).toEqual([3, 150]);
    expect(points[points.length - 1]?.slice(0, 2)).toEqual([188, 12]);
    for (let k = 1; k < points.length; k += 1) {
      const a = points[k - 1]!;
      const b = points[k]!;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it('counts clamped points when a vertex is outside the field', () => {
    const surface = createMeshSurface(rampField((e) => e));
    const { points, clampedCount } = drapeLine(surface, [
      [100, 80, 0],
      [900, 80, 0],
    ]);
    expect(clampedCount).toBeGreaterThan(0);
    expect(points[points.length - 1]?.[2]).toBeCloseTo(200 + DRAPE_LIFT_M, 3);
  });

  it('throws on a non-finite terrain height', () => {
    const field = rampField(() => 1);
    field.data[5] = Number.NaN;
    const surface = createMeshSurface(field);
    expect(() =>
      drapeLine(surface, [
        [0, 160, 0],
        [50, 160, 0],
      ]),
    ).toThrow(/non-finite/);
  });

  it('never goes below the mesh surface on the fixture cone, checked every 0.25 m', () => {
    const surface = createMeshSurface(makeFixtureField(), 16);
    const { points } = drapeLine(surface, [
      [-250, 200, 0],
      [60, -20, 0],
      [260, -230, 0],
    ]);
    expect(minClearance(surface, points, 0.25)).toBeGreaterThanOrEqual(DRAPE_LIFT_M - 1e-6);
  });
});

describe('lift cables', () => {
  it('maps each measured aerialway type to its offset and throws only for a missing tag', () => {
    expect(liftOffsetM('way/1', { aerialway: 'chair_lift' })).toBe(8);
    expect(liftOffsetM('way/2', { aerialway: 'drag_lift' })).toBe(1.5);
    expect(liftOffsetM('way/3', { aerialway: 'rope_tow' })).toBe(1.5);
    expect(liftOffsetM('way/4', { aerialway: 'magic_carpet' })).toBe(0.3);
    expect(Object.keys(LIFT_OFFSET_M)).toHaveLength(4);
    expect(() => liftOffsetM('way/6', {})).toThrow(/way\/6/);
  });

  it('gives every other aerialway value the display-only default, including inherited property names', () => {
    expect(LIFT_DEFAULT_OFFSET_M).toBe(8);
    expect(liftOffsetM('way/5', { aerialway: 'gondola' })).toBe(LIFT_DEFAULT_OFFSET_M);
    expect(liftOffsetM('way/7', { aerialway: 'toString' })).toBe(LIFT_DEFAULT_OFFSET_M);
  });

  it('returns a finite offset for all ten aerialway values that #8 maps to kind lift', () => {
    // The list copies #8's lift values (#8 kind mapping, Decisions item 3). The default means a value
    // missing from this list cannot break the scene; this test pins the ten known ones as finite.
    const ten = [
      'chair_lift',
      'mixed_lift',
      'gondola',
      'cable_car',
      'drag_lift',
      't-bar',
      'j-bar',
      'platter',
      'rope_tow',
      'magic_carpet',
    ];
    expect(ten).toHaveLength(10);
    for (const value of ten) {
      expect(Number.isFinite(liftOffsetM('way/9', { aerialway: value })), value).toBe(true);
    }
  });

  it('raises each vertex by the offset and does not densify', () => {
    const surface = createMeshSurface(rampField((e) => e));
    const { points } = cableLine(
      surface,
      [
        [10, 100, 0],
        [100, 100, 0],
        [190, 100, 0],
      ],
      8,
    );
    expect(points).toHaveLength(3);
    expect(points.map((p) => p[2])).toEqual([18, 108, 198]);
  });

  it('reports negative clearance when a cable crosses a ridge (the instrument can fail)', () => {
    const surface = createMeshSurface(rampField((e) => (e === 100 ? 60 : 0)));
    const { points } = cableLine(
      surface,
      [
        [0, 80, 0],
        [200, 80, 0],
      ],
      0.3,
    );
    expect(minClearance(surface, points, 1)).toBeLessThan(0);
  });
});

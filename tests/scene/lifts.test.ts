import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { parseAreas } from '../../src/data/load-areas';
import { buildAreaLayer, type AreaEntry, type SceneMapper } from '../../src/scene/areas';
import type { Vec3 } from '../../src/scene/drape';
import { createMeshSurface } from '../../src/scene/heightfield';
import {
  BULLWHEEL_SEGMENTS,
  CHAIR_SPACING_M,
  CHAIR_SPEED_MPS,
  MAX_FRAME_DELTA_MS,
  ROPE_OFFSET_M,
  buildChairGeometry,
  buildLiftLoop,
  chairCount,
  installLiftChairs,
} from '../../src/scene/lifts';
import { makeFixtureField } from '../fixtures/make-field';

const BOTTOM: Vec3 = [0, 0, 0];
const TOP: Vec3 = [200, 0, 20];
const straight = buildLiftLoop([BOTTOM, TOP]);
const slope = Math.hypot(200, 20);
const arcLength =
  BULLWHEEL_SEGMENTS * 2 * ROPE_OFFSET_M * Math.sin(Math.PI / (2 * BULLWHEEL_SEGMENTS));
const mapper: SceneMapper = (east, north, elevation) => [east, elevation, -north];

describe('buildLiftLoop / loopPoint', () => {
  it('runs the up-line on the left of the bottom-to-top direction', () => {
    const start = straight.loopPoint(0);
    expect(start.east).toBeCloseTo(0, 6);
    expect(start.north).toBeCloseTo(ROPE_OFFSET_M, 6);
    expect(start.tangentEast).toBeCloseTo(1, 6);
    const mid = straight.loopPoint(slope / 2);
    expect(mid.east).toBeCloseTo(100, 6);
    expect(mid.north).toBeCloseTo(ROPE_OFFSET_M, 6);
    expect(mid.elevation).toBeCloseTo(10, 6);
  });

  it('rounds the top bullwheel from the left rope to the right rope', () => {
    const entry = straight.loopPoint(slope);
    expect([entry.east, entry.north, entry.elevation]).toEqual([
      expect.closeTo(200, 6),
      expect.closeTo(ROPE_OFFSET_M, 6),
      expect.closeTo(20, 6),
    ]);
    const apex = straight.loopPoint(slope + arcLength / 2);
    expect(apex.east).toBeCloseTo(200 + ROPE_OFFSET_M, 2);
    expect(apex.north).toBeCloseTo(0, 6);
    expect(apex.elevation).toBeCloseTo(20, 6);
    expect(apex.tangentNorth).toBeCloseTo(-1, 2);
  });

  it('descends the right rope heading downhill', () => {
    const down = straight.loopPoint(slope + arcLength + slope / 2);
    expect(down.east).toBeCloseTo(100, 6);
    expect(down.north).toBeCloseTo(-ROPE_OFFSET_M, 6);
    expect(down.elevation).toBeCloseTo(10, 6);
    expect(down.tangentEast).toBeCloseTo(-1, 6);
  });

  it('rounds the bottom bullwheel back to the left rope', () => {
    const apex = straight.loopPoint(2 * slope + arcLength + arcLength / 2);
    expect(apex.east).toBeCloseTo(-ROPE_OFFSET_M, 2);
    expect(apex.north).toBeCloseTo(0, 6);
    expect(apex.elevation).toBeCloseTo(0, 6);
    expect(apex.tangentNorth).toBeCloseTo(1, 2);
    expect(straight.length).toBeCloseTo(2 * slope + 2 * arcLength, 6);
  });

  it('wraps: s and s plus the loop length are the same point, negative s included', () => {
    const a = straight.loopPoint(37);
    const b = straight.loopPoint(37 + straight.length);
    const c = straight.loopPoint(37 - straight.length);
    expect(b.east).toBeCloseTo(a.east, 6);
    expect(c.north).toBeCloseTo(a.north, 6);
  });

  it('treats the lower end as the bottom whichever way the cable is ordered', () => {
    const flipped = buildLiftLoop([TOP, BOTTOM]);
    expect(flipped.reversed).toBe(true);
    expect(flipped.loopPoint(0).north).toBeCloseTo(ROPE_OFFSET_M, 6);
    expect(flipped.up[0]).toEqual(straight.up[0]);
  });

  it('keeps cable heights and offsets each rope sideways through a bend', () => {
    const bent = buildLiftLoop([
      [0, 0, 0],
      [100, 0, 10],
      [100, 100, 30],
    ]);
    expect(bent.up.map((p) => p[2])).toEqual([0, 10, 30]);
    // Left of an eastward then northward line is north, then west; the corner is mitred inward on the left.
    expect(bent.up[1]?.[0]).toBeCloseTo(100 - ROPE_OFFSET_M, 6);
    expect(bent.up[1]?.[1]).toBeCloseTo(ROPE_OFFSET_M, 6);
    expect(bent.down[1]?.[0]).toBeCloseTo(100 + ROPE_OFFSET_M, 6);
  });

  it('throws for fewer than two distinct plan points', () => {
    expect(() => buildLiftLoop([BOTTOM, [0, 0, 5]])).toThrow(/at least 2 distinct/);
  });
});

describe('chairs', () => {
  it('places about one chair per CHAIR_SPACING_M, at least one', () => {
    expect(chairCount(180)).toBe(10);
    expect(chairCount(5)).toBe(1);
    expect(chairCount(straight.length)).toBe(Math.floor(straight.length / CHAIR_SPACING_M));
  });

  it('merges the hanger, seat and back into one geometry about 2.5 m tall', () => {
    const geometry = buildChairGeometry();
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.y).toBeCloseTo(-2.55, 6);
    expect(geometry.boundingBox?.max.y).toBeCloseTo(0, 6);
    expect(geometry.boundingBox?.max.z).toBeCloseTo(0.7, 6);
  });
});

function installOn(loop = straight, visible = true) {
  const lines = [{ visible }];
  const entry = { lift: loop, lines } as unknown as AreaEntry;
  const root = { add() {}, remove() {} } as unknown as Parameters<typeof installLiftChairs>[0];
  const chairs = installLiftChairs(root, [entry], mapper, { fadeCentre: { east: 0, north: 0 } });
  return { chairs, lines };
}

const positionOf = (
  mesh: NonNullable<ReturnType<typeof installOn>['chairs']['mesh']>,
  i: number,
) => {
  const m = new Matrix4();
  mesh.getMatrixAt(i, m);
  const p = new Vector3();
  m.decompose(p, new Quaternion(), new Vector3());
  return p;
};

describe('installLiftChairs', () => {
  it('moves up-line chairs uphill and down-line chairs downhill', () => {
    const { chairs } = installOn();
    const mesh = chairs.mesh as NonNullable<typeof chairs.mesh>;
    chairs.step(0);
    const before = Array.from({ length: chairs.count }, (_, i) => positionOf(mesh, i));
    for (let k = 0; k < 4; k += 1) chairs.step(MAX_FRAME_DELTA_MS);
    const metres = (CHAIR_SPEED_MPS * 4 * MAX_FRAME_DELTA_MS) / 1000;
    let upMoved = 0;
    let downMoved = 0;
    before.forEach((a, i) => {
      const b = positionOf(mesh, i);
      // Straight sections only: skip chairs near a bullwheel.
      if (a.x < 5 || a.x > 195 || b.x < 5 || b.x > 195) return;
      // Scene z is minus north: the up-line (north +1.5) is z -1.5.
      if (a.z < 0 && b.z < 0) {
        expect(b.x - a.x).toBeGreaterThan(metres * 0.9);
        upMoved += 1;
      } else if (a.z > 0 && b.z > 0) {
        expect(b.x - a.x).toBeLessThan(-metres * 0.9);
        downMoved += 1;
      }
    });
    expect(upMoved).toBeGreaterThan(2);
    expect(downMoved).toBeGreaterThan(2);
  });

  it('caps one frame at MAX_FRAME_DELTA_MS and freezes at speed 0', () => {
    const { chairs } = installOn();
    const mesh = chairs.mesh as NonNullable<typeof chairs.mesh>;
    chairs.step(0);
    const a = positionOf(mesh, 0);
    chairs.step(60_000);
    const b = positionOf(mesh, 0);
    expect(Math.abs(b.x - a.x)).toBeLessThan(CHAIR_SPEED_MPS * (MAX_FRAME_DELTA_MS / 1000) + 1e-6);
    chairs.setSpeed(0);
    chairs.step(100);
    expect(positionOf(mesh, 0).x).toBeCloseTo(b.x, 9);
  });

  it('draws the chair at 1 / verticalScale so exaggeration keeps its true size', () => {
    const { chairs } = installOn();
    const mesh = chairs.mesh as NonNullable<typeof chairs.mesh>;
    chairs.step(0, 4);
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    const scale = new Vector3();
    m.decompose(new Vector3(), new Quaternion(), scale);
    expect(scale.y).toBeCloseTo(0.25, 6);
    expect(scale.x).toBeCloseTo(1, 6);
  });

  it('collapses the chairs of a hidden lift and restores them when shown', () => {
    const { chairs, lines } = installOn(straight, false);
    const mesh = chairs.mesh as NonNullable<typeof chairs.mesh>;
    chairs.step(16);
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixScale(m).length()).toBe(0);
    (lines[0] as { visible: boolean }).visible = true;
    chairs.step(16);
    mesh.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixScale(m).length()).toBeGreaterThan(1);
  });

  it('is deterministic: the same steps give byte-identical matrices', () => {
    const run = (): number[] => {
      const { chairs } = installOn();
      for (let k = 0; k < 20; k += 1) chairs.step(16.7);
      return Array.from((chairs.mesh as NonNullable<typeof chairs.mesh>).instanceMatrix.array);
    };
    expect(run()).toEqual(run());
  });
});

describe('lifts in the area layer', () => {
  const fixtureUrl = new URL('../fixtures/areas.geojson', import.meta.url);
  const areas = parseAreas(JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')));
  const surface = createMeshSurface(makeFixtureField(), 16);
  const layer = buildAreaLayer(areas, surface, mapper, { width: 800, height: 600 });

  it('draws every lift as two rope lines and gives it a loop; other kinds get neither', () => {
    for (const [id, entry] of layer.registry) {
      if (entry.area.kind === 'lift') {
        expect(entry.lines, id).toHaveLength(2);
        expect(entry.lift, id).toBeDefined();
      } else {
        expect(entry.lift, id).toBeUndefined();
      }
    }
  });

  it('puts the two ropes about 2 x ROPE_OFFSET_M apart', () => {
    const entry = layer.registry.get('way/1006') as AreaEntry;
    const [a, b] = entry.lines.map((l) => l.geometry.getAttribute('instanceStart'));
    const ax = a?.getX(0) ?? 0;
    const az = a?.getZ(0) ?? 0;
    const bx = b?.getX(0) ?? 0;
    const bz = b?.getZ(0) ?? 0;
    expect(Math.hypot(ax - bx, az - bz)).toBeCloseTo(2 * ROPE_OFFSET_M, 4);
  });

  it('builds chairs for the fixture lifts', () => {
    const root = { add() {}, remove() {} } as unknown as Parameters<typeof installLiftChairs>[0];
    const chairs = installLiftChairs(root, layer.registry.values(), mapper, {
      fadeCentre: { east: 0, north: 0 },
    });
    expect(chairs.count).toBeGreaterThan(0);
  });
});

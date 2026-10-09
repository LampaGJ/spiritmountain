import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type BufferGeometry,
  Color,
  FrontSide,
  Layers,
  MeshStandardMaterial,
  ShaderLib,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { describe, expect, it } from 'vitest';
import { parseAreas } from '../../src/data/load-areas';
import { buildAreaLayer, trailTopHeight, type SceneMapper } from '../../src/scene/areas';
import {
  applyWallLanes,
  buildTrailWalls,
  canopyFromSurface,
  canopyProfile,
  createWallMaterial,
  laneIndex,
  mergeWalls,
  mitredNormals,
  sportVertexColor,
  wallIndexCount,
  wallOffsets,
  wallSports,
  wallVertexCount,
  WALL_BURY_M,
  WALL_MAX_LANES,
  WALL_MAX_M,
  WALL_MIN_M,
  WALL_THICKNESS_M,
  type TrailWalls,
} from '../../src/scene/walls';
import { createLineRaycaster } from '../../src/scene/pick';
import { applyRadialFade } from '../../src/scene/fade';
import { applyHorizonBlend, createHorizonUniforms } from '../../src/scene/horizon';
import { DRAPE_LIFT_M, type Vec3 } from '../../src/scene/drape';
import { createMeshSurface, type Heightfield } from '../../src/scene/heightfield';
import { SPORT_COLOR } from '../../src/scene/palette';
import type { Activity } from '../../src/scene/sport-routing';
import type { Annotation } from '../../src/schema/annotation';
import { makeFixtureField } from '../fixtures/make-field';

const toScene: SceneMapper = (east, north, elevation) => [east, elevation, -north];

describe('canopyProfile', () => {
  const pts = Array.from({ length: 9 }, (_, i) => [i * 5, 0]);

  it('falls back to WALL_MIN_M everywhere without a canopy source', () => {
    expect(canopyProfile(pts, null)).toEqual(pts.map(() => WALL_MIN_M));
  });

  it('takes a 5-vertex moving maximum, then clamps to [WALL_MIN_M, WALL_MAX_M]', () => {
    const heights = [0, 0, 0, 0, 12, 0, 0, 0, 50];
    const profile = canopyProfile(pts, (east) => heights[east / 5] as number);
    expect(profile).toEqual([2, 2, 12, 12, 12, 12, 30, 30, 30]);
    expect(Math.max(...profile)).toBe(WALL_MAX_M);
  });

  it('treats a non-finite or negative canopy as open ground', () => {
    const profile = canopyProfile(pts.slice(0, 3), (east) => (east === 0 ? Number.NaN : -4));
    expect(profile).toEqual([2, 2, 2]);
  });

  it('scales the clamped height by the DEBUG factor', () => {
    expect(canopyProfile(pts.slice(0, 2), () => 10, 0.5)).toEqual([5, 5]);
    expect(canopyProfile(pts.slice(0, 2), () => 10, 0)).toEqual([0, 0]);
  });
});

describe('canopyFromSurface', () => {
  const field = (value: number, originEast: number, cols: number): Heightfield => ({
    cols,
    rows: cols,
    originEast,
    originNorth: 100,
    cellSizeEast: 10,
    cellSizeNorth: 10,
    data: new Float32Array(cols * cols).fill(value),
  });
  const header = {} as never;

  it('reads the core where it covers the point, else the square, minus bare earth', () => {
    const canopy = canopyFromSurface(
      {
        square: { header, heightfield: field(130, 0, 21) },
        core: { header, heightfield: field(118, 0, 6) },
      },
      () => 100,
    );
    expect(canopy?.(20, 80)).toBeCloseTo(18, 6);
    expect(canopy?.(150, 0)).toBeCloseTo(30, 6);
  });

  it('is null when both layers failed', () => {
    expect(canopyFromSurface({ square: { error: 'x' }, core: { error: 'y' } }, () => 0)).toBe(null);
  });

  it('is NaN outside every layer, so the profile treats it as open ground', () => {
    const canopy = canopyFromSurface(
      { square: { error: 'x' }, core: { header, heightfield: field(118, 0, 6) } },
      () => 100,
    );
    expect(canopy?.(1000, 1000)).toBeNaN();
  });
});

describe('wallSports and wallOffsets', () => {
  it('orders walls left to right in ActivitySchema order, whatever the annotation order', () => {
    expect(wallSports(['nordic-skate', 'nordic-classic'], new Set(), 'hike')).toEqual([
      'nordic-classic',
      'nordic-skate',
    ]);
  });

  it('drops walls whose sport is filtered off, and keeps the routed sport for one-sport trails', () => {
    const both: Activity[] = ['nordic-classic', 'nordic-skate'];
    expect(wallSports(both, new Set<Activity>(['nordic-skate']), 'hike')).toEqual(['nordic-skate']);
    expect(wallSports(['hike'], new Set(), 'hike')).toEqual(['hike']);
    expect(wallSports([], new Set(), 'mountain-bike')).toEqual(['mountain-bike']);
    expect(wallSports(both, new Set<Activity>(['hike']), 'nordic-classic')).toEqual([
      'nordic-classic',
    ]);
  });

  it('centres k walls on the centreline, one thickness apart', () => {
    expect(wallOffsets(1, 4)).toEqual([0]);
    expect(wallOffsets(2, 4)).toEqual([-2, 2]);
    expect(wallOffsets(3, 4)).toEqual([-4, 0, 4]);
  });
});

describe('mitredNormals', () => {
  it('points right of the line direction and mitres a 90-degree corner by sqrt(2)', () => {
    const normals = mitredNormals([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    // East-going: right is south.
    expect(normals[0]?.[0]).toBeCloseTo(0, 9);
    expect(normals[0]?.[1]).toBeCloseTo(-1, 9);
    expect(normals[0]?.[2]).toBeCloseTo(1, 9);
    // Corner: the averaged normal (south-east) and the mitre scale 1 / cos(45 deg).
    expect(normals[1]?.[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(normals[1]?.[1]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(normals[1]?.[2]).toBeCloseTo(Math.SQRT2, 9);
  });
});

describe('buildTrailWalls', () => {
  const world: Vec3[] = [
    [0, 0, 100 + 10 + DRAPE_LIFT_M],
    [10, 0, 100 + 20 + DRAPE_LIFT_M],
    [20, 0, 100 + 30 + DRAPE_LIFT_M],
  ];
  const bare = (): number => 100;
  const positions = (walls: TrailWalls): Vector3[] => {
    const a = walls.geometry.getAttribute('position');
    return Array.from({ length: a.count }, (_, i) => new Vector3(a.getX(i), a.getY(i), a.getZ(i)));
  };
  const colours = (walls: TrailWalls): number[][] => {
    const a = walls.geometry.getAttribute('color');
    return Array.from({ length: a.count }, (_, i) => [a.getX(i), a.getY(i), a.getZ(i)]);
  };
  const f32 = (rgb: readonly number[]): number[] => rgb.map((v) => Math.fround(v));
  /** Geometric (winding) normals of every triangle, with the triangle centroid. */
  const triangles = (walls: TrailWalls): { normal: Vector3; centroid: Vector3 }[] => {
    const p = positions(walls);
    const index = Array.from(walls.geometry.index?.array ?? []);
    const out: { normal: Vector3; centroid: Vector3 }[] = [];
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [index[t], index[t + 1], index[t + 2]].map(
        (i) => p[i as number] as Vector3,
      );
      const ab = new Vector3().subVectors(b as Vector3, a as Vector3);
      const ac = new Vector3().subVectors(c as Vector3, a as Vector3);
      out.push({
        normal: new Vector3().crossVectors(ab, ac),
        centroid: new Vector3()
          .add(a as Vector3)
          .add(b as Vector3)
          .add(c as Vector3)
          .divideScalar(3),
      });
    }
    return out;
  };

  it('uses one lit, opaque, front-sided, vertex-coloured material, depth-tested and depth-written, no polygonOffset', () => {
    const m = createWallMaterial();
    expect(m).toBeInstanceOf(MeshStandardMaterial);
    expect(m.side).toBe(FrontSide);
    expect(m.vertexColors).toBe(true);
    expect(m.opacity).toBe(1);
    expect(m.transparent).toBe(false);
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(true);
    expect(m.polygonOffset).toBe(false);
  });

  it('is one closed box per sport: 6n + 8 vertices, sides, top and both caps', () => {
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['hike']);
    expect(walls.geometry.getAttribute('position').count).toBe(wallVertexCount(3));
    expect(wallVertexCount(3)).toBe(26);
    expect(walls.geometry.index?.count).toBe(wallIndexCount(3));
    expect(walls.geometry.getAttribute('normal').count).toBe(26);
    const tris = triangles(walls);
    const unit = tris.map(({ normal }) => normal.clone().normalize());
    // Two end caps: triangles whose normal runs along the line (east axis), 2 per cap.
    expect(unit.filter((n) => n.x < -0.99).length).toBe(2);
    expect(unit.filter((n) => n.x > 0.99).length).toBe(2);
    // The top (it climbs with the fixture): triangles facing up, two per segment, none facing down (the buried bottom is open).
    expect(unit.filter((n) => n.y > 0.5).length).toBe(4);
    expect(unit.filter((n) => n.y < -0.5).length).toBe(0);
  });

  it('spans bare earth minus WALL_BURY_M to the line height minus DRAPE_LIFT_M, WALL_THICKNESS_M across', () => {
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['hike']);
    const p = positions(walls);
    expect(Math.min(...p.map((v) => v.y))).toBeCloseTo(100 - WALL_BURY_M, 5);
    expect(Math.max(...p.map((v) => v.y))).toBeCloseTo(130, 5);
    const zs = p.map((v) => v.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(WALL_THICKNESS_M, 5);
    const hike = new Color(SPORT_COLOR.hike);
    for (const c of colours(walls)) {
      expect(c[0]).toBeCloseTo(hike.r, 6);
      expect(c[1]).toBeCloseTo(hike.g, 6);
      expect(c[2]).toBeCloseTo(hike.b, 6);
    }
  });

  it('winds every face outward (straight wall: winding normal points away from the box centre)', () => {
    const walls = buildTrailWalls('way/1', world, () => 100, toScene);
    walls.setSports(['hike']);
    const centre = new Vector3(10, 110, 0);
    for (const { normal, centroid } of triangles(walls)) {
      expect(normal.dot(new Vector3().subVectors(centroid, centre))).toBeGreaterThan(0);
    }
    // The stored normal attribute agrees with the winding.
    const n = walls.geometry.getAttribute('normal');
    const index = Array.from(walls.geometry.index?.array ?? []);
    triangles(walls).forEach(({ normal }, t) => {
      const i = index[t * 3] as number;
      expect(normal.dot(new Vector3(n.getX(i), n.getY(i), n.getZ(i)))).toBeGreaterThan(0);
    });
  });

  it('mitres a 90-degree corner so both faces keep the full half-thickness', () => {
    const corner: Vec3[] = [
      [0, 0, 110 + DRAPE_LIFT_M],
      [10, 0, 110 + DRAPE_LIFT_M],
      [10, 10, 110 + DRAPE_LIFT_M],
    ];
    const walls = buildTrailWalls('way/1', corner, bare, toScene);
    walls.setSports(['hike']);
    const p = positions(walls).map((v) => [v.x, -v.z] as const);
    const half = WALL_THICKNESS_M / 2;
    // Left (inside) and right (outside) corners of the mitre.
    expect(p.some(([e, n]) => Math.abs(e - (10 - half)) < 1e-4 && Math.abs(n - half) < 1e-4)).toBe(
      true,
    );
    expect(p.some(([e, n]) => Math.abs(e - (10 + half)) < 1e-4 && Math.abs(n + half) < 1e-4)).toBe(
      true,
    );
  });

  it('puts k lanes side by side in one box, left to right, and re-centres when one is filtered off (#73)', () => {
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['nordic-classic', 'nordic-skate'], 2);
    // One box for the trail, k lanes across it (#73 replaced the k boxes of #67).
    expect(walls.geometry.getAttribute('position').count).toBe(wallVertexCount(3));
    const p = positions(walls);
    const lane = walls.geometry.getAttribute('lane');
    const north = p.map((v) => -v.z);
    // Looking east, left is north: lane 0 (classic, first in ActivitySchema order) is the north face at +4, the
    // skate lane the south face at -4.
    const leftFace = north.filter((_, i) => lane.getX(i) === 0);
    const rightFace = north.filter((_, i) => lane.getX(i) === 1);
    expect(Math.min(...leftFace)).toBeCloseTo(WALL_THICKNESS_M, 5);
    expect(Math.max(...rightFace)).toBeCloseTo(-WALL_THICKNESS_M, 5);
    expect(colours(walls)[0]).toEqual(f32(sportVertexColor('nordic-classic')));
    const second = walls.geometry.getAttribute('laneColor1');
    expect([second.getX(0), second.getY(0), second.getZ(0)]).toEqual(
      f32(sportVertexColor('nordic-skate')),
    );
    // Every lane runs full height: the one box does.
    expect(Math.max(...p.map((v) => v.y))).toBeCloseTo(130, 5);
    expect(walls.setHalfWidthM).toBe(WALL_THICKNESS_M);
    walls.setSports(['nordic-skate'], 2);
    const alone = positions(walls).map((v) => -v.z);
    expect(Math.min(...alone)).toBeCloseTo(-WALL_THICKNESS_M / 2, 5);
    expect(Math.max(...alone)).toBeCloseTo(WALL_THICKNESS_M / 2, 5);
    // The cull still keeps the full set clear.
    expect(walls.setHalfWidthM).toBe(WALL_THICKNESS_M);
  });

  it('rebuilds at a new thickness', () => {
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['hike']);
    walls.setThickness(10);
    const zs = positions(walls).map((v) => v.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(10, 5);
    expect(walls.setHalfWidthM).toBe(5);
  });

  it('merges only visible trails into one indexed geometry with offset indices and normals', () => {
    const a = buildTrailWalls('a', world, bare, toScene);
    const b = buildTrailWalls('b', world, bare, toScene);
    const c = buildTrailWalls('c', world, bare, toScene);
    for (const x of [a, b, c]) x.setSports(['hike']);
    b.visible = false;
    const merged = mergeWalls([a, b, c]);
    expect(merged.getAttribute('position').count).toBe(2 * wallVertexCount(3));
    expect(merged.getAttribute('normal').count).toBe(2 * wallVertexCount(3));
    expect(merged.index?.count).toBe(2 * wallIndexCount(3));
    expect(Math.max(...Array.from(merged.index?.array ?? []))).toBe(2 * wallVertexCount(3) - 1);
    expect(merged.groups).toEqual([]);
  });
});

describe('one wall, k lanes (#73)', () => {
  const bare = (): number => 100;
  const plan = (walls: TrailWalls, from: number, count: number): number[][] => {
    const p = walls.geometry.getAttribute('position');
    return Array.from({ length: count }, (_, i) => [p.getX(from + i), -p.getZ(from + i)]);
  };
  const orient = (p: number[], q: number[], r: number[]): number =>
    Math.sign(
      ((q[0] as number) - (p[0] as number)) * ((r[1] as number) - (p[1] as number)) -
        ((q[1] as number) - (p[1] as number)) * ((r[0] as number) - (p[0] as number)),
    );
  /** Pairs of non-adjacent segments of a polyline that properly cross. */
  const selfCrossings = (line: number[][]): number => {
    let count = 0;
    for (let i = 0; i + 1 < line.length; i += 1) {
      for (let j = i + 2; j + 1 < line.length; j += 1) {
        const [a, b, c, d] = [line[i], line[i + 1], line[j], line[j + 1]] as number[][];
        const crosses =
          orient(a as number[], b as number[], c as number[]) *
            orient(a as number[], b as number[], d as number[]) <
            0 &&
          orient(c as number[], d as number[], a as number[]) *
            orient(c as number[], d as number[], b as number[]) <
            0;
        if (crosses) count += 1;
      }
    }
    return count;
  };
  /**
   * A 20 m radius left-hand bend as OSM draws it (a chord every 30 degrees), with the extra vertices drapeLine's
   * mesh-edge split puts close to a corner (0.5 m either side): the shape that folded the inner face before #73.
   */
  const bend: Vec3[] = (() => {
    const corners = Array.from({ length: 7 }, (_, i) => {
      const a = (i * Math.PI) / 6;
      return [20 * Math.sin(a), 20 - 20 * Math.cos(a)] as const;
    });
    const out: Vec3[] = [[-30, 0, 110 + DRAPE_LIFT_M]];
    corners.forEach((c, i) => {
      const before = corners[i - 1];
      const after = corners[i + 1];
      const near = (o: readonly [number, number]): Vec3 => {
        const length = Math.hypot(o[0] - c[0], o[1] - c[1]);
        return [c[0] + ((o[0] - c[0]) / length) * 0.5, c[1] + ((o[1] - c[1]) / length) * 0.5, 110];
      };
      if (before) out.push(near(before));
      out.push([c[0], c[1], 110]);
      if (after) out.push(near(after));
    });
    out.push([-30, 40, 110]);
    return out.map(([e, n]) => [e, n, 110 + DRAPE_LIFT_M] as Vec3);
  })();

  it('builds an outline that never crosses itself on a 20 m radius bend 12 m wide', () => {
    const walls = buildTrailWalls('way/1', bend, bare, toScene, 6);
    walls.setSports(['nordic-classic', 'nordic-skate']);
    const n = bend.length;
    expect(walls.geometry.getAttribute('position').count).toBe(wallVertexCount(n));
    const left = plan(walls, 0, n);
    const right = plan(walls, 2 * n, n);
    // The full width is k lanes: 12 m between the faces on the straight run in.
    expect(
      Math.hypot(...[0, 1].map((a) => (left[0]?.[a] ?? 0) - (right[0]?.[a] ?? 0))),
    ).toBeCloseTo(12, 5);
    expect(selfCrossings(left)).toBe(0);
    expect(selfCrossings(right)).toBe(0);
    const ring = [...left, ...[...right].reverse(), left[0] as number[]];
    expect(selfCrossings(ring)).toBe(0);
  });

  it('runs the lane attribute from 0 at the left face to 1 at the right face', () => {
    const world: Vec3[] = [
      [0, 0, 110],
      [10, 0, 110],
      [20, 0, 110],
    ];
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['nordic-classic', 'nordic-skate', 'snowshoe']);
    const lane = walls.geometry.getAttribute('lane');
    const count = walls.geometry.getAttribute('laneCount');
    const values = Array.from({ length: lane.count }, (_, i) => lane.getX(i));
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(1);
    expect(values.every((v) => v === 0 || v === 1)).toBe(true);
    // Left face (first 2n) all 0, right face (next 2n) all 1, the top's left row 0 and right row 1.
    expect(values.slice(0, 6).every((v) => v === 0)).toBe(true);
    expect(values.slice(6, 12).every((v) => v === 1)).toBe(true);
    expect(values.slice(12, 18)).toEqual([0, 0, 0, 1, 1, 1]);
    // Across the width 0..1 the shader picks the lanes in order, k stripes.
    expect([0, 0.2, 0.34, 0.5, 0.7, 0.99, 1].map((t) => laneIndex(t, 3))).toEqual([
      0, 0, 1, 1, 2, 2, 2,
    ]);
    expect(Array.from({ length: count.count }, (_, i) => count.getX(i)).every((k) => k === 3)).toBe(
      true,
    );
  });

  it('lands lane 0 colour on the left face and lane 1 colour on the right face for k = 2', () => {
    const world: Vec3[] = [
      [0, 0, 110],
      [10, 0, 110],
    ];
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['nordic-classic', 'nordic-skate']);
    const g = walls.geometry;
    const colourAt = (i: number): number[] => {
      const k = g.getAttribute('laneCount').getX(i);
      const which = laneIndex(g.getAttribute('lane').getX(i), k);
      const a = g.getAttribute(which === 0 ? 'color' : `laneColor${which}`);
      return [a.getX(i), a.getY(i), a.getZ(i)];
    };
    const p = g.getAttribute('position');
    const f32 = (rgb: readonly number[]): number[] => rgb.map((v) => Math.fround(v));
    // Left face: vertices 0..3 (n = 2, lo row then hi row), north of the east-going line.
    for (let i = 0; i < 4; i += 1) {
      expect(-p.getZ(i)).toBeCloseTo(WALL_THICKNESS_M, 5);
      expect(colourAt(i)).toEqual(f32(sportVertexColor('nordic-classic')));
    }
    for (let i = 4; i < 8; i += 1) {
      expect(-p.getZ(i)).toBeCloseTo(-WALL_THICKNESS_M, 5);
      expect(colourAt(i)).toEqual(f32(sportVertexColor('nordic-skate')));
    }
  });

  it('shrinks the width when a sport is filtered off, and keeps the full set for the tree cull', () => {
    const world: Vec3[] = [
      [0, 0, 110],
      [10, 0, 110],
    ];
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['nordic-classic', 'nordic-skate', 'snowshoe'], 3);
    const width = (): number => {
      const zs = plan(walls, 0, walls.geometry.getAttribute('position').count).map(
        (q) => q[1] as number,
      );
      return Math.max(...zs) - Math.min(...zs);
    };
    expect(width()).toBeCloseTo(3 * WALL_THICKNESS_M, 5);
    walls.setSports(['nordic-skate', 'snowshoe'], 3);
    expect(width()).toBeCloseTo(2 * WALL_THICKNESS_M, 5);
    expect(walls.geometry.getAttribute('laneCount').getX(0)).toBe(2);
    expect(walls.setHalfWidthM).toBe((3 * WALL_THICKNESS_M) / 2);
  });

  it('refuses more lanes than the shader carries', () => {
    const walls = buildTrailWalls(
      'way/1',
      [
        [0, 0, 110],
        [10, 0, 110],
      ],
      bare,
      toScene,
    );
    const five: Activity[] = ['hike', 'trail-run', 'mountain-bike', 'fat-bike', 'snowshoe'];
    expect(five.length).toBeGreaterThan(WALL_MAX_LANES);
    expect(() => walls.setSports(five)).toThrow(/lanes/);
  });

  it('merges the lane attributes with the rest', () => {
    const a = buildTrailWalls('a', bend, bare, toScene);
    const b = buildTrailWalls('b', bend, bare, toScene);
    a.setSports(['hike']);
    b.setSports(['nordic-classic', 'nordic-skate']);
    const merged = mergeWalls([a, b]);
    const n = wallVertexCount(bend.length);
    for (const name of ['lane', 'laneCount', 'laneColor1', 'laneColor2', 'laneColor3']) {
      expect(merged.getAttribute(name).count).toBe(2 * n);
    }
    expect(merged.getAttribute('laneCount').getX(0)).toBe(1);
    expect(merged.getAttribute('laneCount').getX(n)).toBe(2);
  });

  it('chains the lane select after the radial fade and before the horizon blend, in one program', () => {
    const m = createWallMaterial();
    applyRadialFade(m, { centre: { east: 0, north: 0 } });
    applyWallLanes(m);
    applyHorizonBlend(m, createHorizonUniforms(0x000000));
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
    } as unknown as WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, {} as never);
    expect(shader.vertexShader).toContain('attribute float lane;');
    expect(shader.vertexShader).toContain('vFadeXZ');
    expect(shader.vertexShader).toContain('vHorizonPos');
    expect(shader.fragmentShader).toContain('vWallLane');
    expect(shader.fragmentShader).not.toContain('#include <color_fragment>');
    expect(shader.fragmentShader).toContain('fadeInner');
    expect(shader.fragmentShader).toContain('uHorizonDist');
    expect(m.customProgramCacheKey()).toBe('radial-fade+wall-lanes+horizon');
    // Idempotent: a second call does not stack another patch.
    applyWallLanes(m);
    expect(m.customProgramCacheKey()).toBe('radial-fade+wall-lanes+horizon');
  });
});

describe('area layer with walls (#64, #67)', () => {
  const fixtureUrl = new URL('../fixtures/areas.geojson', import.meta.url);
  const areas = parseAreas(JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')));
  const surface = createMeshSurface(makeFixtureField(), 16);
  const build = () =>
    buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 }, { walls: true });
  const lineYs = (line: Line2): number[] => {
    const start = line.geometry.getAttribute('instanceStart');
    return Array.from({ length: start.count }, (_, i) => start.getY(i));
  };
  const lineXZ = (line: Line2): [number, number][] => {
    const start = line.geometry.getAttribute('instanceStart');
    return Array.from({ length: start.count }, (_, i) => [start.getX(i), -start.getZ(i)]);
  };

  it('lifts trail lines to bare earth plus WALL_MIN_M plus DRAPE_LIFT_M without a canopy', () => {
    const layer = build();
    const line = layer.registry.get('way/1003')?.lines[0] as Line2;
    lineYs(line).forEach((y, i) => {
      const [e, n] = lineXZ(line)[i] as [number, number];
      expect(y).toBeCloseTo(surface.sample(e, n).height + WALL_MIN_M + DRAPE_LIFT_M, 3);
    });
  });

  it('follows the canopy once set, and drops back to the plain drape when walls are off', () => {
    const layer = build();
    layer.setCanopy(() => 12);
    const line = layer.registry.get('way/1003')?.lines[0] as Line2;
    const [e, n] = lineXZ(line)[0] as [number, number];
    expect(lineYs(line)[0]).toBeCloseTo(surface.sample(e, n).height + 12 + DRAPE_LIFT_M, 3);
    layer.setWallScale(2);
    expect(lineYs(line)[0]).toBeCloseTo(surface.sample(e, n).height + 24 + DRAPE_LIFT_M, 3);
    layer.setWallsOn(false);
    expect(lineYs(line)[0]).toBeCloseTo(surface.sample(e, n).height + DRAPE_LIFT_M, 3);
    expect(layer.wallMesh?.visible).toBe(false);
  });

  it('keeps lifts straight and gives them, and polygons, no walls', () => {
    const layer = build();
    expect(layer.registry.get('way/1006')?.walls).toBeUndefined();
    expect(layer.registry.get('way/1004')?.walls).toBeUndefined();
    expect(layer.registry.get('way/1002')?.walls).toBeDefined();
  });

  it('draws every wall in one mesh inside the layer group, never pickable', () => {
    const layer = build();
    const mesh = layer.wallMesh;
    expect(mesh?.parent).toBe(layer.group);
    const walled = [...layer.registry.values()].filter((e) => e.walls).length;
    const trails = areas.filter((a) => a.kind !== 'lift' && a.geometry.type === 'LineString');
    expect(walled).toBe(trails.length);
    expect(walled).toBeGreaterThan(0);
    const own = layer.registry.get('way/1002')?.walls?.geometry.getAttribute('position');
    expect(mesh?.geometry.getAttribute('position').count).toBeGreaterThan(own?.count ?? 0);
    expect(mesh?.geometry.getAttribute('normal')).toBeDefined();
    const hits: unknown[] = [];
    mesh?.raycast({} as never, hits as never);
    expect(hits).toEqual([]);
  });

  it('gives a two-sport trail two walls classic-left of skate, re-routes on filter and follows area visibility', () => {
    const layer = build();
    const note: Annotation = {
      areaId: 'way/1002',
      activities: [{ activity: 'nordic-skate' }, { activity: 'nordic-classic' }],
    } as unknown as Annotation;
    const annotations = new Map([['way/1002', note]]);
    layer.applyStrands(annotations);
    layer.route(annotations, new Set());
    const walls = layer.registry.get('way/1002')?.walls;
    expect(walls?.sports).toEqual(['nordic-classic', 'nordic-skate']);
    expect(walls?.setHalfWidthM).toBe(WALL_THICKNESS_M);
    layer.route(annotations, new Set<Activity>(['nordic-skate']));
    expect(walls?.sports).toEqual(['nordic-skate']);
    expect(walls?.setHalfWidthM).toBe(WALL_THICKNESS_M);
    const before = layer.wallMesh?.geometry.getAttribute('position').count ?? 0;
    const own = walls?.geometry.getAttribute('position').count ?? 0;
    for (const line of layer.registry.get('way/1002')?.lines ?? []) line.visible = false;
    layer.route(annotations, new Set());
    expect(walls?.visible).toBe(false);
    expect(layer.wallMesh?.geometry.getAttribute('position').count).toBe(before - own);
  });

  it('rebuilds every wall at a new thickness and reports the centrelines and set half-widths for the tree cull', () => {
    const layer = build();
    const lines = layer.wallLines();
    expect(lines.length).toBe([...layer.registry.values()].filter((e) => e.walls).length);
    expect(lines.every((l) => l.halfWidthM === WALL_THICKNESS_M / 2)).toBe(true);
    expect(lines.every((l) => l.points.length >= 2)).toBe(true);
    layer.setWallThickness(8);
    expect(layer.wallLines().every((l) => l.halfWidthM === 4)).toBe(true);
    const own = layer.registry.get('way/1002')?.walls?.geometry.getAttribute('position');
    const zs = Array.from({ length: own?.count ?? 0 }, (_, i) => own?.getZ(i) ?? 0);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThanOrEqual(8 - 1e-6);
  });

  it('exposes the wall top for the trail sign anchor', () => {
    const layer = build();
    layer.setCanopy(() => 15);
    expect(trailTopHeight(0, 0)).toBeCloseTo(surface.sample(0, 0).height + 15, 6);
    layer.setWallsOn(false);
    expect(trailTopHeight(0, 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('hands out the one radial-faded material for the horizon blend', () => {
    const layer = build();
    expect(layer.wallMaterials).toHaveLength(1);
    expect(layer.wallMaterials.every((m) => m.depthWrite && m.side === FrontSide)).toBe(true);
    expect(layer.wallMesh?.material).toBe(layer.wallMaterials[0]);
    // The lane select (#73) chains after the radial fade; the caller adds the horizon blend on top.
    expect(layer.wallMaterials[0]?.customProgramCacheKey()).toBe('radial-fade+wall-lanes');
    layer.setWallFadeCentre({ east: 1, north: 2 });
  });
});

describe('trail lines hidden behind the walls (#74)', () => {
  const fixtureUrl = new URL('../fixtures/areas.geojson', import.meta.url);
  const areas = parseAreas(JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')));
  const surface = createMeshSurface(makeFixtureField(), 16);
  const build = () =>
    buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 }, { walls: true });
  const drawn = (line: Line2): boolean => new Layers().test(line.layers);
  const picked = (line: Line2): boolean => createLineRaycaster().layers.test(line.layers);
  const linesOf = (layer: ReturnType<typeof build>, id: string): Line2[] => [
    ...(layer.registry.get(id)?.lines ?? []),
  ];

  it('draws no line over a walled trail by default, but still picks it and keeps its filter visibility', () => {
    const layer = build();
    expect(layer.trailLinesVisible).toBe(false);
    for (const line of linesOf(layer, 'way/1001')) {
      expect(drawn(line)).toBe(false);
      expect(picked(line)).toBe(true);
      expect(line.visible).toBe(true);
    }
  });

  it('keeps lifts and polygons drawn', () => {
    const layer = build();
    for (const id of ['way/1006', 'way/1004']) {
      for (const line of linesOf(layer, id)) expect(drawn(line)).toBe(true);
    }
  });

  it('the toggle restores the lines and hides them again, strands included', () => {
    const layer = build();
    layer.setTrailLinesVisible(true);
    expect(layer.trailLinesVisible).toBe(true);
    expect(linesOf(layer, 'way/1001').every(drawn)).toBe(true);
    layer.setTrailLinesVisible(false);
    expect(linesOf(layer, 'way/1001').some(drawn)).toBe(false);
    const note: Annotation = {
      areaId: 'way/1001',
      activities: [
        { activity: 'alpine-ski', seasons: [], notes: '' },
        { activity: 'snowboard', seasons: [], notes: '' },
      ],
      stakeholders: [],
      notes: '',
    };
    layer.applyStrands(new Map([['way/1001', note]]));
    const strands = linesOf(layer, 'way/1001');
    expect(strands).toHaveLength(2);
    expect(strands.some(drawn)).toBe(false);
    expect(strands.every(picked)).toBe(true);
  });

  it('draws the lines again while the walls are off', () => {
    const layer = build();
    layer.setWallsOn(false);
    expect(linesOf(layer, 'way/1001').every(drawn)).toBe(true);
    layer.setWallsOn(true);
    expect(linesOf(layer, 'way/1001').some(drawn)).toBe(false);
  });

  it('highlights the wall range of an area in the merged mesh and clears it', () => {
    const layer = build();
    const geometry = () => layer.wallMesh?.geometry as BufferGeometry;
    const marks = () => Array.from(geometry().getAttribute('highlight').array as Float32Array);
    expect(marks().every((m) => m === 0)).toBe(true);
    layer.setWallHighlight(new Set(['way/1002']));
    const own = layer.registry.get('way/1002')?.walls?.geometry.getAttribute('position').count ?? 0;
    expect(own).toBeGreaterThan(0);
    expect(marks().filter((m) => m === 1)).toHaveLength(own);
    layer.setWallHighlight(new Set());
    expect(marks().every((m) => m === 0)).toBe(true);
  });

  it('keeps a highlight across a re-merge', () => {
    const layer = build();
    layer.setWallHighlight(new Set(['way/1002']));
    layer.setWallThickness(6);
    const marks = layer.wallMesh?.geometry.getAttribute('highlight').array as Float32Array;
    const own = layer.registry.get('way/1002')?.walls?.geometry.getAttribute('position').count ?? 0;
    expect(Array.from(marks).filter((m) => m === 1)).toHaveLength(own);
  });

  it('mixes the highlight toward white in the lane shader', () => {
    const m = createWallMaterial();
    applyWallLanes(m);
    const shader = {
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
      uniforms: {},
    } as unknown as WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, null as never);
    expect(shader.vertexShader).toContain('attribute float highlight;');
    expect(shader.fragmentShader).toContain('vWallHighlight');
  });
});

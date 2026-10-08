import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Color, FrontSide, MeshStandardMaterial, Vector3 } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { describe, expect, it } from 'vitest';
import { parseAreas } from '../../src/data/load-areas';
import { buildAreaLayer, trailTopHeight, type SceneMapper } from '../../src/scene/areas';
import {
  buildTrailWalls,
  canopyFromSurface,
  canopyProfile,
  createWallMaterial,
  mergeWalls,
  mitredNormals,
  sportVertexColor,
  wallIndexCount,
  wallOffsets,
  wallSports,
  wallVertexCount,
  WALL_BURY_M,
  WALL_MAX_M,
  WALL_MIN_M,
  WALL_THICKNESS_M,
  type TrailWalls,
} from '../../src/scene/walls';
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

  it('puts k walls side by side, left to right, and re-centres when one is filtered off', () => {
    const walls = buildTrailWalls('way/1', world, bare, toScene);
    walls.setSports(['nordic-classic', 'nordic-skate'], 2);
    expect(walls.geometry.getAttribute('position').count).toBe(2 * wallVertexCount(3));
    const p = positions(walls);
    const first = p.slice(0, wallVertexCount(3)).map((v) => -v.z);
    const second = p.slice(wallVertexCount(3)).map((v) => -v.z);
    // Looking east, left is north: classic (first in ActivitySchema order) spans north 0..4, skate 0..-4.
    expect(Math.min(...first)).toBeCloseTo(0, 5);
    expect(Math.max(...first)).toBeCloseTo(WALL_THICKNESS_M, 5);
    expect(Math.min(...second)).toBeCloseTo(-WALL_THICKNESS_M, 5);
    expect(Math.max(...second)).toBeCloseTo(0, 5);
    expect(colours(walls)[0]).toEqual(f32(sportVertexColor('nordic-classic')));
    expect(colours(walls)[wallVertexCount(3)]).toEqual(f32(sportVertexColor('nordic-skate')));
    // Both walls run full height.
    expect(Math.max(...p.slice(wallVertexCount(3)).map((v) => v.y))).toBeCloseTo(130, 5);
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
    layer.setWallFadeCentre({ east: 1, north: 2 });
  });
});

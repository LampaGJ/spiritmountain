import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Color, DoubleSide } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { describe, expect, it } from 'vitest';
import { parseAreas } from '../../src/data/load-areas';
import { buildAreaLayer, trailTopHeight, type SceneMapper } from '../../src/scene/areas';
import {
  canopyFromSurface,
  canopyProfile,
  buildCurtain,
  createCurtainMaterial,
  curtainStripes,
  mergeCurtains,
  sportVertexColor,
  CURTAIN_MAX_M,
  CURTAIN_MIN_M,
  CURTAIN_OPACITY,
  type Curtain,
} from '../../src/scene/curtain';
import { DRAPE_LIFT_M, type Vec3 } from '../../src/scene/drape';
import { createMeshSurface, type Heightfield } from '../../src/scene/heightfield';
import { SPORT_COLOR } from '../../src/scene/palette';
import type { Activity } from '../../src/scene/sport-routing';
import type { Annotation } from '../../src/schema/annotation';
import { makeFixtureField } from '../fixtures/make-field';

const toScene: SceneMapper = (east, north, elevation) => [east, elevation, -north];

describe('canopyProfile', () => {
  const pts = Array.from({ length: 9 }, (_, i) => [i * 5, 0]);

  it('falls back to CURTAIN_MIN_M everywhere without a canopy source', () => {
    expect(canopyProfile(pts, null)).toEqual(pts.map(() => CURTAIN_MIN_M));
  });

  it('takes a 5-vertex moving maximum, then clamps to [CURTAIN_MIN_M, CURTAIN_MAX_M]', () => {
    const heights = [0, 0, 0, 0, 12, 0, 0, 0, 50];
    const profile = canopyProfile(pts, (east) => heights[east / 5] as number);
    expect(profile).toEqual([2, 2, 12, 12, 12, 12, 30, 30, 30]);
    expect(Math.max(...profile)).toBe(CURTAIN_MAX_M);
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

describe('curtainStripes', () => {
  it('orders stripes bottom to top in ActivitySchema order, whatever the annotation order', () => {
    expect(curtainStripes(['nordic-skate', 'nordic-classic'], new Set(), 'hike')).toEqual([
      'nordic-classic',
      'nordic-skate',
    ]);
  });

  it('drops stripes whose sport is filtered off, and keeps the routed sport for one-sport trails', () => {
    const both: Activity[] = ['nordic-classic', 'nordic-skate'];
    expect(curtainStripes(both, new Set<Activity>(['nordic-skate']), 'hike')).toEqual([
      'nordic-skate',
    ]);
    expect(curtainStripes(['hike'], new Set(), 'hike')).toEqual(['hike']);
    expect(curtainStripes([], new Set(), 'mountain-bike')).toEqual(['mountain-bike']);
    expect(curtainStripes(both, new Set<Activity>(['hike']), 'nordic-classic')).toEqual([
      'nordic-classic',
    ]);
  });
});

describe('buildCurtain', () => {
  const world: Vec3[] = [
    [0, 0, 100 + 10 + DRAPE_LIFT_M],
    [10, 0, 100 + 20 + DRAPE_LIFT_M],
    [20, 0, 100 + 30 + DRAPE_LIFT_M],
  ];
  const bare = (): number => 100;
  const ys = (curtain: Curtain): number[] => {
    const a = curtain.geometry.getAttribute('position');
    return Array.from({ length: a.count }, (_, i) => a.getY(i));
  };
  const colours = (curtain: Curtain): number[][] => {
    const a = curtain.geometry.getAttribute('color');
    return Array.from({ length: a.count }, (_, i) => [a.getX(i), a.getY(i), a.getZ(i)]);
  };
  const f32 = (rgb: readonly number[]): number[] => rgb.map((v) => Math.fround(v));

  it('uses one double-sided vertex-coloured basic material at CURTAIN_OPACITY, depth-tested and depth-written, no polygonOffset', () => {
    const m = createCurtainMaterial();
    expect(m.side).toBe(DoubleSide);
    expect(m.vertexColors).toBe(true);
    expect(m.opacity).toBe(CURTAIN_OPACITY);
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(true);
    expect(m.polygonOffset).toBe(false);
  });

  it('spans bare earth to the line height minus DRAPE_LIFT_M, one quad per segment, in the sport colour', () => {
    const curtain = buildCurtain('way/1', world, bare, toScene);
    curtain.setStripes(['hike']);
    expect(ys(curtain)).toEqual([100, 100, 100, 110, 120, 130]);
    expect(curtain.geometry.index?.count).toBe(12);
    const hike = new Color(SPORT_COLOR.hike);
    for (const c of colours(curtain)) {
      expect(c[0]).toBeCloseTo(hike.r, 6);
      expect(c[1]).toBeCloseTo(hike.g, 6);
      expect(c[2]).toBeCloseTo(hike.b, 6);
    }
  });

  it('splits into k equal stripes bottom to top, and redistributes when one is hidden', () => {
    const curtain = buildCurtain('way/1', world, bare, toScene);
    curtain.setStripes(['nordic-classic', 'nordic-skate']);
    // Stripe 0: bottom row then mid row; stripe 1: mid row then top row.
    expect(ys(curtain)).toEqual([100, 100, 100, 105, 110, 115, 105, 110, 115, 110, 120, 130]);
    expect(colours(curtain)[0]).toEqual(f32(sportVertexColor('nordic-classic')));
    expect(colours(curtain)[6]).toEqual(f32(sportVertexColor('nordic-skate')));
    expect(curtain.stripes).toEqual(['nordic-classic', 'nordic-skate']);
    curtain.setStripes(['nordic-skate']);
    expect(ys(curtain)).toEqual([100, 100, 100, 110, 120, 130]);
    expect(colours(curtain)[0]).toEqual(f32(sportVertexColor('nordic-skate')));
  });

  it('merges only visible curtains into one indexed geometry with offset indices', () => {
    const a = buildCurtain('a', world, bare, toScene);
    const b = buildCurtain('b', world, bare, toScene);
    const c = buildCurtain('c', world, bare, toScene);
    for (const x of [a, b, c]) x.setStripes(['hike']);
    b.visible = false;
    const merged = mergeCurtains([a, b, c]);
    expect(merged.getAttribute('position').count).toBe(12);
    expect(merged.index?.count).toBe(24);
    expect(Math.max(...Array.from(merged.index?.array ?? []))).toBe(11);
    expect(merged.groups).toEqual([]);
  });
});

describe('area layer with curtains (#64)', () => {
  const fixtureUrl = new URL('../fixtures/areas.geojson', import.meta.url);
  const areas = parseAreas(JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')));
  const surface = createMeshSurface(makeFixtureField(), 16);
  const build = () =>
    buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 }, { curtains: true });
  const lineYs = (line: Line2): number[] => {
    const start = line.geometry.getAttribute('instanceStart');
    return Array.from({ length: start.count }, (_, i) => start.getY(i));
  };
  const lineXZ = (line: Line2): [number, number][] => {
    const start = line.geometry.getAttribute('instanceStart');
    return Array.from({ length: start.count }, (_, i) => [start.getX(i), -start.getZ(i)]);
  };

  it('lifts trail lines to bare earth plus CURTAIN_MIN_M plus DRAPE_LIFT_M without a canopy', () => {
    const layer = build();
    const line = layer.registry.get('way/1003')?.lines[0] as Line2;
    lineYs(line).forEach((y, i) => {
      const [e, n] = lineXZ(line)[i] as [number, number];
      expect(y).toBeCloseTo(surface.sample(e, n).height + CURTAIN_MIN_M + DRAPE_LIFT_M, 3);
    });
  });

  it('follows the canopy once set, and drops back to the plain drape when curtains are off', () => {
    const layer = build();
    layer.setCanopy(() => 12);
    const line = layer.registry.get('way/1003')?.lines[0] as Line2;
    const [e, n] = lineXZ(line)[0] as [number, number];
    expect(lineYs(line)[0]).toBeCloseTo(surface.sample(e, n).height + 12 + DRAPE_LIFT_M, 3);
    layer.setCurtainScale(2);
    expect(lineYs(line)[0]).toBeCloseTo(surface.sample(e, n).height + 24 + DRAPE_LIFT_M, 3);
    layer.setCurtainsOn(false);
    expect(lineYs(line)[0]).toBeCloseTo(surface.sample(e, n).height + DRAPE_LIFT_M, 3);
    expect(layer.curtainMesh?.visible).toBe(false);
  });

  it('keeps lifts straight and gives them, and polygons, no curtain', () => {
    const layer = build();
    expect(layer.registry.get('way/1006')?.curtain).toBeUndefined();
    expect(layer.registry.get('way/1004')?.curtain).toBeUndefined();
    expect(layer.registry.get('way/1002')?.curtain).toBeDefined();
  });

  it('draws every curtain in one mesh inside the layer group, never pickable', () => {
    const layer = build();
    const mesh = layer.curtainMesh;
    expect(mesh?.parent).toBe(layer.group);
    const walls = [...layer.registry.values()].filter((e) => e.curtain).length;
    const trails = areas.filter((a) => a.kind !== 'lift' && a.geometry.type === 'LineString');
    expect(walls).toBe(trails.length);
    expect(walls).toBeGreaterThan(0);
    const perWall = layer.registry.get('way/1002')?.curtain?.geometry.getAttribute('position');
    expect(mesh?.geometry.getAttribute('position').count).toBeGreaterThan(perWall?.count ?? 0);
    const hits: unknown[] = [];
    mesh?.raycast({} as never, hits as never);
    expect(hits).toEqual([]);
  });

  it('stripes a two-sport trail classic below skate, re-routes on filter and follows area visibility', () => {
    const layer = build();
    const note: Annotation = {
      areaId: 'way/1002',
      activities: [{ activity: 'nordic-skate' }, { activity: 'nordic-classic' }],
    } as unknown as Annotation;
    const annotations = new Map([['way/1002', note]]);
    layer.applyStrands(annotations);
    layer.route(annotations, new Set());
    const curtain = layer.registry.get('way/1002')?.curtain;
    expect(curtain?.stripes).toEqual(['nordic-classic', 'nordic-skate']);
    layer.route(annotations, new Set<Activity>(['nordic-skate']));
    expect(curtain?.stripes).toEqual(['nordic-skate']);
    const before = layer.curtainMesh?.geometry.getAttribute('position').count ?? 0;
    const own = curtain?.geometry.getAttribute('position').count ?? 0;
    for (const line of layer.registry.get('way/1002')?.lines ?? []) line.visible = false;
    layer.route(annotations, new Set());
    expect(curtain?.visible).toBe(false);
    expect(layer.curtainMesh?.geometry.getAttribute('position').count).toBe(before - own);
  });

  it('exposes the curtain top for the trail sign anchor', () => {
    const layer = build();
    layer.setCanopy(() => 15);
    expect(trailTopHeight(0, 0)).toBeCloseTo(surface.sample(0, 0).height + 15, 6);
    layer.setCurtainsOn(false);
    expect(trailTopHeight(0, 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('hands out the one radial-faded material for the horizon blend', () => {
    const layer = build();
    expect(layer.curtainMaterials).toHaveLength(1);
    expect(layer.curtainMaterials.every((m) => m.transparent && m.depthWrite)).toBe(true);
    expect(layer.curtainMesh?.material).toBe(layer.curtainMaterials[0]);
    layer.setCurtainFadeCentre({ east: 1, north: 2 });
  });
});

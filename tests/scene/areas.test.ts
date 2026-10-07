import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Line2 } from 'three/addons/lines/Line2.js';
import { describe, expect, it } from 'vitest';
import { parseAreas } from '../../src/data/load-areas';
import { DRAPE_LIFT_M, LIFT_DEFAULT_OFFSET_M, minClearance } from '../../src/scene/drape';
import {
  GHOST_OPACITY,
  GHOST_RENDER_ORDER,
  buildAreaLayer,
  buildAreaPositions,
  type SceneMapper,
} from '../../src/scene/areas';
import { createMeshSurface } from '../../src/scene/heightfield';
import { SPORT_COLOR } from '../../src/scene/palette';
import { KIND_DEFAULT_ACTIVITY, type Activity } from '../../src/scene/sport-routing';
import type { Annotation } from '../../src/schema/annotation';
import type { Area } from '../../src/schema/area';
import { makeFixtureField } from '../fixtures/make-field';

const fixtureUrl = new URL('../fixtures/areas.geojson', import.meta.url);
const areas = parseAreas(JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')));
const surface = createMeshSurface(makeFixtureField(), 16);
const mapper =
  (exaggeration: number): SceneMapper =>
  (east, north, elevation) => [east, elevation * exaggeration, -north];
const byId = (id: string): Area => areas.find((a) => a.id === id) as Area;

describe('buildAreaPositions', () => {
  it('adds lift offsets in world metres BEFORE vertical exaggeration (exaggeration 2)', () => {
    const chair = buildAreaPositions(byId('way/1006'), surface, mapper(2));
    const ground = surface.sample(-120, -20).height;
    expect(chair.scene[0]?.[1]).toBeCloseTo((ground + 8) * 2, 4);
    expect(chair.scene[0]?.[1]).not.toBeCloseTo(ground * 2 + 8, 1);
  });

  it('uses the offset for each aerialway type', () => {
    const expected: Array<[string, number, number, number]> = [
      ['way/1006', -120, -20, 8],
      ['way/1007', 200, -60, 1.5],
      ['way/1008', -200, 230, 1.5],
      ['way/1009', 100, -250, 0.3],
    ];
    for (const [id, east, north, offset] of expected) {
      const built = buildAreaPositions(byId(id), surface, mapper(1));
      expect(built.scene[0]?.[1]).toBeCloseTo(surface.sample(east, north).height + offset, 4);
    }
  });

  it('maps east to x and north to -z through the mapper', () => {
    const built = buildAreaPositions(byId('way/1002'), surface, mapper(1));
    expect(built.scene[0]?.[0]).toBeCloseTo(-280, 6);
    expect(built.scene[0]?.[2]).toBeCloseTo(200, 6);
  });

  it('keeps every drawn line at or above the mesh surface plus the lift, checked every 0.25 m', () => {
    for (const area of areas.filter((a) => a.kind !== 'lift')) {
      const built = buildAreaPositions(area, surface, mapper(1));
      for (const line of built.world) {
        expect(minClearance(surface, line, 0.25), area.id).toBeGreaterThanOrEqual(
          DRAPE_LIFT_M - 1e-6,
        );
      }
    }
  });

  it('keeps every lift cable above the mesh at every 1 m sample', () => {
    for (const area of areas.filter((a) => a.kind === 'lift')) {
      const built = buildAreaPositions(area, surface, mapper(1));
      expect(built.liftMinClearanceM, area.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('counts the clamped vertex of the downhill run that lies outside the field', () => {
    expect(buildAreaPositions(byId('way/1001'), surface, mapper(1)).clampedCount).toBeGreaterThan(
      0,
    );
    expect(buildAreaPositions(byId('way/1002'), surface, mapper(1)).clampedCount).toBe(0);
  });

  it('closes a polygon ring and draws one line per ring', () => {
    const park = buildAreaPositions(byId('way/1004'), surface, mapper(1));
    expect(park.world).toHaveLength(1);
    const ring = park.world[0] as Array<[number, number, number]>;
    expect(ring[0]?.slice(0, 2)).toEqual(ring[ring.length - 1]?.slice(0, 2));
    const holey: Area = {
      ...byId('way/1004'),
      id: 'way/2000',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [150, 120, 0],
            [230, 120, 0],
            [230, 200, 0],
            [150, 200, 0],
            [150, 120, 0],
          ],
          [
            [170, 140, 0],
            [190, 140, 0],
            [190, 160, 0],
          ],
        ],
      },
    };
    const built = buildAreaPositions(holey, surface, mapper(1));
    expect(built.world).toHaveLength(2);
    const hole = built.world[1] as Array<[number, number, number]>;
    expect(hole[0]?.slice(0, 2)).toEqual(hole[hole.length - 1]?.slice(0, 2));
  });

  it('draws an unlisted aerialway value at the default offset instead of throwing', () => {
    const gondola: Area = {
      ...byId('way/1006'),
      id: 'way/3003',
      osmTags: { aerialway: 'gondola' },
    };
    const built = buildAreaPositions(gondola, surface, mapper(1));
    expect(built.scene[0]?.[1]).toBeCloseTo(
      surface.sample(-120, -20).height + LIFT_DEFAULT_OFFSET_M,
      4,
    );
  });

  it('throws, naming the area, for a lift polygon, a lift with no aerialway tag, and a degenerate line', () => {
    const lift = byId('way/1006');
    expect(() =>
      buildAreaPositions(
        { ...lift, id: 'way/3000', geometry: byId('way/1004').geometry },
        surface,
        mapper(1),
      ),
    ).toThrow(/way\/3000/);
    expect(() =>
      buildAreaPositions({ ...lift, id: 'way/3001', osmTags: {} }, surface, mapper(1)),
    ).toThrow(/way\/3001/);
    const dot: Area = {
      ...byId('way/1002'),
      id: 'way/3002',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
    };
    expect(() => buildAreaPositions(dot, surface, mapper(1))).toThrow(/way\/3002/);
  });
});

describe('buildAreaLayer', () => {
  const layer = buildAreaLayer(areas, surface, mapper(1), { width: 800, height: 600 });

  it('registers every area id exactly once and tags every Line2 with a matching areaId', () => {
    expect([...layer.registry.keys()]).toEqual(areas.map((a) => a.id));
    let seen = 0;
    layer.group.traverse((object) => {
      if (object instanceof Line2 && !object.name.endsWith(':ghost')) {
        seen += 1;
        const id = object.userData['areaId'] as string;
        expect(layer.registry.get(id)?.lines).toContain(object);
      }
    });
    expect(seen).toBe(layer.stats.lineCount);
    expect(seen).toBe(areas.length);
  });

  it('shares one material per sport, first painted with the kind default, coloured from the palette, with a resolution set', () => {
    const run = layer.registry.get('way/1001')?.lines[0] as Line2;
    expect(run.material).toBe(layer.materials['alpine-ski']);
    expect(run.userData['baseMaterial']).toBe(layer.materials['alpine-ski']);
    expect(layer.materials['alpine-ski'].color.getHex()).toBe(SPORT_COLOR['alpine-ski']);
    expect(layer.materials['alpine-ski'].resolution.x).toBe(800);
    expect(layer.materials['lift-ride'].resolution.y).toBe(600);
    const lift = layer.registry.get('way/1006')?.lines[0] as Line2;
    expect(lift.material).toBe(layer.materials['lift-ride']);
  });

  it('gives a polygon with holes several Line2 objects under one areaId', () => {
    const holey: Area = {
      ...byId('way/1004'),
      id: 'way/2000',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [150, 120, 0],
            [230, 120, 0],
            [230, 200, 0],
            [150, 200, 0],
            [150, 120, 0],
          ],
          [
            [170, 140, 0],
            [190, 140, 0],
            [190, 160, 0],
            [170, 140, 0],
          ],
        ],
      },
    };
    const holeyLayer = buildAreaLayer([holey], surface, mapper(1), { width: 1, height: 1 });
    expect(holeyLayer.registry.get('way/2000')?.lines).toHaveLength(2);
    for (const line of holeyLayer.registry.get('way/2000')?.lines ?? []) {
      expect(line.userData['areaId']).toBe('way/2000');
    }
  });

  it('tags every Line2 in every registry entry, including a two-ring entry, with userData.areaId equal to its key', () => {
    const twoRing: Area = {
      ...byId('way/1004'),
      id: 'way/2001',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [150, 120, 0],
            [230, 120, 0],
            [230, 200, 0],
            [150, 200, 0],
            [150, 120, 0],
          ],
          [
            [170, 140, 0],
            [190, 140, 0],
            [190, 160, 0],
            [170, 140, 0],
          ],
        ],
      },
    };
    const both = buildAreaLayer([...areas, twoRing], surface, mapper(1), { width: 1, height: 1 });
    expect(both.registry.get('way/2001')?.lines).toHaveLength(2);
    for (const [id, entry] of both.registry) {
      expect(entry.lines.length, id).toBeGreaterThan(0);
      for (const line of entry.lines) expect(line.userData['areaId'], id).toBe(id);
    }
  });

  it('throws on a duplicate area id', () => {
    expect(() =>
      buildAreaLayer([byId('way/1002'), byId('way/1002')], surface, mapper(1), {
        width: 1,
        height: 1,
      }),
    ).toThrow(/duplicate area id way\/1002/);
  });

  it('reports lift clearance and clamped vertices in the stats', () => {
    expect(layer.stats.clampedVertexCount).toBeGreaterThan(0);
    expect(layer.stats.liftMinClearanceM).toBeGreaterThanOrEqual(0);
  });
});

describe('ghost pass (#36)', () => {
  const toScene: SceneMapper = (e, n, z) => [e, z, -n];
  const layer = buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 });

  it('gives every line one ghost child sharing its geometry, faint, depth-test off, after the ground, unpickable', () => {
    for (const { area, lines } of layer.registry.values()) {
      for (const line of lines) {
        expect(line.children).toHaveLength(1);
        const ghost = line.children[0] as Line2;
        expect(ghost.geometry).toBe(line.geometry);
        expect(ghost.material).toBe(layer.ghostMaterials[KIND_DEFAULT_ACTIVITY[area.kind]]);
        expect(ghost.renderOrder).toBe(GHOST_RENDER_ORDER);
        expect(ghost.raycast(null as never, [])).toBeUndefined();
      }
    }
    const ghost = layer.ghostMaterials['alpine-ski'];
    expect([ghost.depthTest, ghost.depthWrite, ghost.transparent]).toEqual([false, false, true]);
    expect(ghost.opacity).toBe(GHOST_OPACITY);
    expect(ghost.color.getHex()).toBe(SPORT_COLOR['alpine-ski']);
  });
});

describe('route (#40)', () => {
  const toScene: SceneMapper = (e, n, z) => [e, z, -n];
  const note = (areaId: string, ...activities: Activity[]): Annotation => ({
    areaId,
    activities: activities.map((activity) => ({ activity, seasons: [], notes: '' })),
    stakeholders: [],
    notes: '',
  });
  const annotations = new Map<string, Annotation>([
    ['way/1001', note('way/1001', 'alpine-ski', 'snowboard')],
    ['way/1002', note('way/1002', 'nordic-classic', 'nordic-skate')],
    ['way/1006', note('way/1006', 'lift-ride')],
  ]);
  const snapshot = (layer: ReturnType<typeof buildAreaLayer>) => {
    const lines: Line2[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Line2) lines.push(o);
    });
    return lines;
  };
  const lineOf = (layer: ReturnType<typeof buildAreaLayer>, id: string) =>
    layer.registry.get(id)?.lines[0] as Line2;

  it('changes line colour with no rebuild: same LineGeometry instances and Line2 count', () => {
    const layer = buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 });
    const before = snapshot(layer);
    const geometries = before.map((l) => l.geometry);
    layer.route(annotations, new Set<Activity>(['snowboard']));
    const after = snapshot(layer);
    expect(after).toHaveLength(before.length);
    expect(after.map((l) => l.geometry)).toEqual(geometries);
    after.forEach((l, i) => expect(l.geometry).toBe(geometries[i]));
    expect(lineOf(layer, 'way/1001').material).toBe(layer.materials.snowboard);
    expect(lineOf(layer, 'way/1001').material.color.getHex()).toBe(SPORT_COLOR.snowboard);
    expect(lineOf(layer, 'way/1002').material).toBe(layer.materials['nordic-classic']);
  });

  it('the ghost child follows the colour; renderOrder and raycast are unchanged', () => {
    const layer = buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 });
    const ghost = lineOf(layer, 'way/1001').children[0] as Line2;
    const raycast = ghost.raycast;
    layer.route(annotations, new Set<Activity>(['snowboard']));
    expect(ghost.material).toBe(layer.ghostMaterials.snowboard);
    expect(ghost.renderOrder).toBe(GHOST_RENDER_ORDER);
    expect(ghost.raycast).toBe(raycast);
    expect(lineOf(layer, 'way/1001').children).toEqual([ghost]);
  });

  it('is idempotent, and an empty selection restores first-annotated colours', () => {
    const layer = buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 });
    const run = lineOf(layer, 'way/1001');
    const skate = lineOf(layer, 'way/1002');
    layer.route(annotations, new Set<Activity>(['snowboard', 'nordic-skate']));
    layer.route(annotations, new Set<Activity>(['snowboard', 'nordic-skate']));
    expect(run.material).toBe(layer.materials.snowboard);
    expect(skate.material).toBe(layer.materials['nordic-skate']);
    expect(run.userData['baseMaterial']).toBe(layer.materials.snowboard);
    layer.route(annotations, new Set());
    expect(run.material).toBe(layer.materials['alpine-ski']);
    expect(skate.material).toBe(layer.materials['nordic-classic']);
    expect((skate.children[0] as Line2).material).toBe(layer.ghostMaterials['nordic-classic']);
    expect(lineOf(layer, 'way/1006').material).toBe(layer.materials['lift-ride']);
  });

  it('leaves a highlighted line on its highlight and only updates the recorded base', () => {
    const layer = buildAreaLayer(areas, surface, toScene, { width: 800, height: 600 });
    const run = lineOf(layer, 'way/1001');
    const highlight = run.material.clone();
    run.material = highlight;
    layer.route(annotations, new Set<Activity>(['snowboard']));
    expect(run.material).toBe(highlight);
    expect(run.userData['baseMaterial']).toBe(layer.materials.snowboard);
    expect((run.children[0] as Line2).material).toBe(layer.ghostMaterials.snowboard);
  });
});

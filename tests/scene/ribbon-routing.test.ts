import { describe, expect, it } from 'vitest';
import { ActivitySchema, type Annotation } from '../../src/schema/annotation';
import type { Area, AreaKind } from '../../src/schema/area';
import { createMeshSurface } from '../../src/scene/heightfield';
import {
  ACTIVITY_TILE,
  KIND_DEFAULT_ACTIVITY,
  TILE_NAMES,
  TILES,
  tileForArea,
  parseTiles,
} from '../../src/scene/ribbon-kinds';
import { assignTiles, buildRibbonLayer } from '../../src/scene/ribbons';
import type { Activity } from '../../src/ui/filter-predicate';
import { makeFixtureField } from '../fixtures/make-field';

const area = (
  id: string,
  kind: AreaKind,
  coords: number[][] = [
    [0, 0, 0],
    [60, 0, 0],
  ],
): Area => ({
  id,
  kind,
  name: null,
  difficulty: null,
  osmTags: {},
  geometry: { type: 'LineString', coordinates: coords as [number, number, number][] },
});
const note = (areaId: string, ...activities: Activity[]): Annotation => ({
  areaId,
  activities: activities.map((activity) => ({ activity, seasons: [], notes: '' })),
  stakeholders: [],
  notes: '',
});
const none = new Set<Activity>();

describe('activity to tile map', () => {
  it('covers every ActivitySchema value except lift-ride, which has no tile', () => {
    for (const activity of ActivitySchema.options) {
      if (activity === 'lift-ride') expect(ACTIVITY_TILE[activity]).toBeNull();
      else expect(TILE_NAMES, activity).toContain(ACTIVITY_TILE[activity]);
    }
    expect(Object.keys(ACTIVITY_TILE).sort()).toEqual([...ActivitySchema.options].sort());
  });

  it('maps each non-lift activity to its own tile, and every tile is used', () => {
    const used = ActivitySchema.options.flatMap((a) =>
      ACTIVITY_TILE[a] ? [ACTIVITY_TILE[a]] : [],
    );
    expect(new Set(used).size).toBe(used.length);
    expect([...used].sort()).toEqual([...TILE_NAMES].sort());
  });

  it('the manifest carries a width and period for every tile', () => {
    for (const name of TILE_NAMES) {
      expect(TILES[name].widthM, name).toBeGreaterThan(0);
      expect(TILES[name].periodM, name).toBeGreaterThan(0);
    }
    expect(TILES['mtb-trail'].widthM).toBe(1.5);
    expect(TILES['downhill-run'].widthM).toBe(12);
  });

  it('parseTiles rejects a manifest that lacks a tile', () => {
    expect(() => parseTiles({ tiles: {} })).toThrow(/no tile/);
  });
});

describe('tileForArea', () => {
  const run = area('way/1', 'downhill-run');

  it('with nothing selected shows the first annotated activity', () => {
    expect(tileForArea(run, note('way/1', 'snowboard', 'alpine-ski'), none)).toBe('snowboard');
    expect(tileForArea(run, note('way/1', 'alpine-ski', 'snowboard'), none)).toBe('downhill-run');
  });

  it('shows the selected activity when the area carries it', () => {
    const annotation = note('way/1', 'alpine-ski', 'snowboard');
    expect(tileForArea(run, annotation, new Set<Activity>(['snowboard']))).toBe('snowboard');
  });

  it('a downhill run with alpine-ski and snowboard switches tiles when Snowboard alone is selected', () => {
    const annotation = note('way/1', 'alpine-ski', 'snowboard');
    expect(tileForArea(run, annotation, none)).toBe('downhill-run');
    expect(tileForArea(run, annotation, new Set<Activity>(['snowboard']))).toBe('snowboard');
    expect(tileForArea(run, annotation, new Set<Activity>(['alpine-ski']))).toBe('downhill-run');
  });

  it('with several selected shows the first annotated activity, not a selected one', () => {
    const annotation = note('way/1', 'alpine-ski', 'snowboard');
    expect(tileForArea(run, annotation, new Set<Activity>(['snowboard', 'hike']))).toBe(
      'downhill-run',
    );
  });

  it('falls back to the first annotated activity when the selected one is not carried', () => {
    const trail = area('way/2', 'nordic-trail');
    const annotation = note('way/2', 'nordic-classic');
    expect(tileForArea(trail, annotation, new Set<Activity>(['nordic-skate']))).toBe(
      'nordic-classic',
    );
    expect(
      tileForArea(
        trail,
        note('way/2', 'nordic-classic', 'nordic-skate'),
        new Set<Activity>(['nordic-skate']),
      ),
    ).toBe('nordic-skate');
  });

  it('skips lift-ride when it is the first annotated activity', () => {
    expect(tileForArea(run, note('way/1', 'lift-ride', 'snowboard'), none)).toBe('snowboard');
  });

  it('uses the kind default when the area has no annotation or no tile-bearing activity', () => {
    expect(tileForArea(area('a', 'nordic-trail'), undefined, none)).toBe('nordic-classic');
    expect(tileForArea(area('b', 'mtb-route'), note('b'), none)).toBe('mtb-trail');
    expect(tileForArea(area('c', 'snow-park'), undefined, none)).toBe('downhill-run');
    expect(KIND_DEFAULT_ACTIVITY.lift).toBeNull();
  });

  it('gives a lift no tile', () => {
    expect(tileForArea(area('l', 'lift'), note('l', 'lift-ride'), none)).toBeNull();
  });
});

describe('assignTiles and the ribbon layer', () => {
  const surface = createMeshSurface(makeFixtureField(), 16);
  const toScene = (e: number, n: number, z: number): [number, number, number] => [e, z, -n];
  const areas = [area('way/1', 'downhill-run'), area('way/2', 'mtb-trail'), area('way/3', 'lift')];
  const annotations = new Map([
    ['way/1', note('way/1', 'alpine-ski', 'snowboard')],
    ['way/2', note('way/2', 'mountain-bike')],
  ]);
  const layer = () =>
    buildRibbonLayer(areas, surface, toScene, TILES, {}, { fadeCentre: { east: 0, north: 0 } });

  it('hides filtered-out areas and never routes a lift', () => {
    const a = assignTiles(areas, annotations, none, new Set(['way/1']));
    expect(a.get('way/1')).toBe('downhill-run');
    expect(a.get('way/2')).toBeNull();
    expect(a.get('way/3')).toBeNull();
  });

  it('starts routed by kind: one mesh per tile in use, no mesh for the lift', () => {
    const l = layer();
    expect(l.group.children.map((c) => c.name).sort()).toEqual([
      'ribbons-downhill-run',
      'ribbons-mtb-trail',
    ]);
    expect(l.stats().areaCount).toBe(2);
    expect(l.stats().triangleCount).toBeGreaterThan(0);
  });

  it('rebuilds on a filter change: Snowboard alone swaps the run to the snowboard tile and widths follow the tile', () => {
    const l = layer();
    l.applyFilter(annotations, new Set<Activity>(['snowboard']), new Set(['way/1', 'way/3']));
    expect(l.group.children.map((c) => c.name)).toEqual(['ribbons-snowboard']);
    const box = (
      l.group.children[0] as unknown as {
        geometry: { boundingBox: { min: { z: number }; max: { z: number } } };
      }
    ).geometry.boundingBox;
    expect(box.max.z - box.min.z).toBeCloseTo(TILES.snowboard.widthM, 4);
  });

  it('dropping every area leaves an empty group', () => {
    const l = layer();
    l.applyFilter(annotations, none, new Set());
    expect(l.group.children).toHaveLength(0);
    expect(l.stats().triangleCount).toBe(0);
  });

  it('re-drapes onto a new active surface and keeps a footprint on bare earth', () => {
    const l = layer();
    const high = createMeshSurface(
      { ...makeFixtureField(), data: makeFixtureField().data.map((v) => v + 50) },
      16,
    );
    const mesh = l.group.children.find((c) => c.name === 'ribbons-mtb-trail') as unknown as {
      geometry: {
        boundingBox: { max: { y: number } };
        getAttribute(n: string): { array: Float32Array };
      };
    };
    const before = mesh.geometry.boundingBox.max.y;
    l.redrape(high);
    expect(mesh.geometry.boundingBox.max.y).toBeGreaterThan(before + 40);
    l.setFootprints([
      [
        [-50, -50],
        [100, -50],
        [100, 50],
        [-50, 50],
        [-50, -50],
      ],
    ]);
    expect(mesh.geometry.boundingBox.max.y).toBeLessThan(before + 5);
  });
});

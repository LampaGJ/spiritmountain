import { Group, Object3D } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { describe, expect, it } from 'vitest';
import type { AreaEntry } from '../../src/scene/areas';
import { applyFilter } from '../../src/scene/filter-apply';
import { matchesFilter, type Filter } from '../../src/ui/filter-predicate';
import { entry, makeAnnotation, makeArea } from '../ui/filter-fixtures';

const winter: Filter = { activities: new Set(), seasons: new Set(['winter']) };
const none: Filter = { activities: new Set(), seasons: new Set() };

/** way/1 and way/2 are two-ring entries (two Line2 objects in `lines`), as #12 builds a polygon with a hole. */
function build() {
  const areas = [
    makeArea('way/1', 'nordic-trail'),
    makeArea('way/2', 'mtb-trail'),
    makeArea('way/3', 'lift'),
    makeArea('way/4', 'downhill-run'),
  ];
  const registry = new Map<string, AreaEntry>();
  for (const area of areas) {
    const rings = area.id === 'way/1' || area.id === 'way/2' ? 2 : 1;
    registry.set(area.id, { area, lines: Array.from({ length: rings }, () => new Line2()) });
  }
  const annotations = new Map([
    ['way/1', makeAnnotation('way/1', [entry('nordic-classic', ['winter'])])],
    ['way/2', makeAnnotation('way/2', [entry('mountain-bike', ['summer'])])],
    ['way/3', makeAnnotation('way/3', [entry('lift-ride', [])])],
  ]);
  return { areas, registry, annotations };
}

const flags = (registry: ReadonlyMap<string, AreaEntry>, id: string): boolean[] =>
  (registry.get(id)?.lines ?? []).map((line) => line.visible);

describe('applyFilter', () => {
  it('sets every ring of every area to exactly the predicate output and keeps lifts visible', () => {
    const { areas, registry, annotations } = build();
    const terrain = new Object3D();
    const result = applyFilter(registry, annotations, winter);
    for (const area of areas) {
      const expected = matchesFilter(area, annotations.get(area.id), winter);
      const seen = flags(registry, area.id);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((visible) => visible === expected)).toBe(true);
    }
    expect(flags(registry, 'way/3')).toEqual([true]);
    expect(flags(registry, 'way/1')).toEqual([true, true]);
    expect(flags(registry, 'way/2')).toEqual([false, false]);
    expect(terrain.visible).toBe(true);
    expect([...result.visibleIds].sort()).toEqual(['way/1', 'way/3']);
  });

  it('counts lifts in N and uses registry size for M', () => {
    const { registry, annotations } = build();
    const result = applyFilter(registry, annotations, winter);
    expect(result.visibleCount).toBe(2);
    expect(result.total).toBe(4);
  });

  it('hides every trail ring but keeps lifts when the filter is cleared (#72 empty default)', () => {
    const { areas, registry, annotations } = build();
    applyFilter(registry, annotations, winter);
    applyFilter(registry, annotations, none);
    for (const area of areas) {
      expect(flags(registry, area.id).every((v) => v === (area.kind === 'lift'))).toBe(true);
    }
  });

  it('toggles .visible on the Line2 objects themselves, never on a parent group', () => {
    const { registry, annotations } = build();
    const group = new Group();
    for (const { lines } of registry.values()) group.add(...lines);
    applyFilter(registry, annotations, winter);
    expect(group.visible).toBe(true);
    expect(flags(registry, 'way/2')).toEqual([false, false]);
  });
});

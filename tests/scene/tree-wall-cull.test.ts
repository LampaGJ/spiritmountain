import { describe, expect, it } from 'vitest';
import type { TreeRecord } from '../../scripts/ingest/trees-schema';
import { ARCHETYPE_CROWN_RADIUS, ARCHETYPES } from '../../src/scene/tree-archetypes';
import {
  buildWallGrid,
  crownRadiusM,
  cullTreesAtWalls,
  distanceToSegment,
  WALL_GRID_CELL_M,
} from '../../src/scene/trees';
import { WALL_THICKNESS_M } from '../../src/scene/walls';

const tree = (east: number, north: number, height = 0, type = 0): TreeRecord => ({
  east,
  north,
  groundElev: 100,
  height,
  type,
  rotation: 0,
  r: 0.2,
  g: 0.4,
  b: 0.2,
});

/** One straight east-going wall from (0, 0) to (200, 0), crossing several 50 m grid cells. */
const straight = [
  {
    points: [
      [0, 0],
      [100, 0],
      [200, 0],
    ] as const,
    halfWidthM: WALL_THICKNESS_M / 2,
  },
];

describe('crown radius', () => {
  it('is the widest lobe reach of each archetype, noise included, and scales with height', () => {
    expect(ARCHETYPE_CROWN_RADIUS).toHaveLength(ARCHETYPES.length);
    ARCHETYPES.forEach((spec, id) => {
      const reach = Math.max(
        ...spec.lobes.map((l) => Math.hypot(l.c[0], l.c[2]) + Math.max(l.r[0], l.r[2])),
      );
      expect(ARCHETYPE_CROWN_RADIUS[id]).toBeCloseTo(reach * (1 + spec.noise), 9);
    });
    expect(crownRadiusM(tree(0, 0, 20, 3))).toBeCloseTo(
      20 * (ARCHETYPE_CROWN_RADIUS[3] as number),
      9,
    );
  });
});

describe('distanceToSegment', () => {
  it('measures to the segment, its ends included', () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 9);
    expect(distanceToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(5, 9);
    expect(distanceToSegment(2, 2, 0, 0, 0, 0)).toBeCloseTo(Math.SQRT2 * 2, 9);
  });
});

describe('cullTreesAtWalls', () => {
  it('culls a tree 1 m from the centreline and keeps one 10 m away (zero crown)', () => {
    const grid = buildWallGrid(straight);
    expect(grid.cellM).toBe(WALL_GRID_CELL_M);
    const { kept, culled } = cullTreesAtWalls([tree(120, 1), tree(120, 10)], grid);
    expect(culled).toBe(1);
    expect(kept.map((t) => t.north)).toEqual([10]);
  });

  it('respects the crown radius: a tall tree 10 m out is culled when its crown reaches the wall', () => {
    const grid = buildWallGrid(straight);
    // A 20 m oak reaches 20 * ARCHETYPE_CROWN_RADIUS[3] (about 13.6 m), more than 10 - 2.
    const tall = tree(120, 10, 20, 3);
    expect(crownRadiusM(tall)).toBeGreaterThan(10 - WALL_THICKNESS_M / 2);
    // A 4 m aspen reaches about 0.9 m: kept.
    const small = tree(120, -10, 4, 0);
    expect(crownRadiusM(small)).toBeLessThan(10 - WALL_THICKNESS_M / 2);
    const { kept, culled } = cullTreesAtWalls([tall, small], grid);
    expect(culled).toBe(1);
    expect(kept).toEqual([small]);
  });

  it('uses the set half-width, so a two-sport set clears twice as wide', () => {
    const single = buildWallGrid(straight);
    const double = buildWallGrid([{ ...straight[0], halfWidthM: WALL_THICKNESS_M } as never]);
    const at3 = [tree(60, 3)];
    expect(cullTreesAtWalls(at3, single).culled).toBe(0);
    expect(cullTreesAtWalls(at3, double).culled).toBe(1);
  });

  it('finds a wall in a neighbouring grid cell and past the line ends', () => {
    const grid = buildWallGrid(straight);
    // Just across a cell boundary from the segment, and just past its far end.
    expect(cullTreesAtWalls([tree(149, -1.5)], grid).culled).toBe(1);
    expect(cullTreesAtWalls([tree(201, 0)], grid).culled).toBe(1);
    expect(cullTreesAtWalls([tree(203, 0)], grid).culled).toBe(0);
  });

  it('keeps every tree with no walls and is deterministic, preserving record order', () => {
    const trees = [tree(1, 1), tree(500, 500), tree(150, 1), tree(-30, 40)];
    expect(cullTreesAtWalls(trees, buildWallGrid([])).kept).toEqual(trees);
    const grid = buildWallGrid(straight);
    const a = cullTreesAtWalls(trees, grid);
    const b = cullTreesAtWalls(trees, grid);
    expect(a).toEqual(b);
    expect(a.kept).toEqual([trees[1], trees[3]]);
  });
});

describe('cullTreesAtWalls margin (#76)', () => {
  // A 3-lane set: half-width 6 m, full width 12 m.
  const wide = buildWallGrid([{ ...straight[0], halfWidthM: 6 } as never]);

  it('keeps a tree whose crown reaches into a wide wall but not out of its far face', () => {
    // Trunk 1 m outside the face; a 16 m oak has a crown narrower than the 12 m wall.
    const oak = tree(60, 7, 16, 3);
    expect(crownRadiusM(oak)).toBeLessThan(12);
    expect(cullTreesAtWalls([oak], wide).culled).toBe(0);
  });

  it('culls a trunk inside the wall face whatever its crown', () => {
    expect(cullTreesAtWalls([tree(60, 5, 0, 0)], wide).culled).toBe(1);
  });

  it('culls a tree whose crown would poke out of the far face of a narrow wall', () => {
    const narrow = buildWallGrid(straight);
    // Half-width 2 (full width 4): a 20 m oak clears the face only beyond 2 + (crown - 4).
    const crown = crownRadiusM(tree(60, 0, 20, 3));
    const limit = WALL_THICKNESS_M / 2 + (crown - WALL_THICKNESS_M);
    expect(limit).toBeGreaterThan(8);
    expect(cullTreesAtWalls([tree(60, limit - 0.5, 20, 3)], narrow).culled).toBe(1);
    expect(cullTreesAtWalls([tree(60, limit + 0.5, 20, 3)], narrow).culled).toBe(0);
  });
});

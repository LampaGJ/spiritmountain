import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_CELLS,
  CANOPY_MIN_CHM_M,
  TRANSFORM_SOURCES,
  buildNoCanopy,
  canopyMask,
  computeChm,
  countTrees,
  fillCanopyHoles,
  isGreen,
  mulberry32,
  placeTrees,
  rasterizeBuildings,
  type Grid,
} from '../../scripts/ingest/trees';
import {
  TreesHeaderSchema,
  packTrees,
  unpackTrees,
  type TreeRecord,
} from '../../scripts/ingest/trees-schema';
import type { BuildingFeature } from '../../src/schema/building';

describe('trees transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of trees.ts', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles) {
        if (!fileName.startsWith('.') || fileName.endsWith('.json')) continue;
        const base = join(dirname(file), fileName);
        const found = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
        if (found === undefined) throw new Error(`cannot resolve ${fileName} from ${file}`);
        visit(relative('.', found));
      }
    };
    visit('scripts/ingest/trees.ts');
    expect([...TRANSFORM_SOURCES].sort()).toEqual([...seen].sort());
  });
});

describe('canopy mask', () => {
  it('isGreen needs G above both R and B by more than 8', () => {
    expect(isGreen(60, 80, 60)).toBe(true);
    expect(isGreen(60, 68, 60)).toBe(false);
    expect(isGreen(60, 69, 60)).toBe(true);
    expect(isGreen(80, 80, 60)).toBe(false);
    expect(isGreen(60, 80, 75)).toBe(false);
  });

  it('computeChm is surface minus bare earth, and 0 where bare earth is unknown', () => {
    const chm = computeChm(
      new Float32Array([110, 105, 120]),
      new Float32Array([100, 100, Number.NaN]),
    );
    expect([...chm]).toEqual([10, 5, 0]);
  });

  it('is canopy only when tall enough, green, and outside buildings', () => {
    const chm = new Float32Array([CANOPY_MIN_CHM_M, CANOPY_MIN_CHM_M - 0.1, 10, 10, 10]);
    const green = new Uint8Array([1, 1, 0, 1, 1]);
    const building = new Uint8Array([0, 0, 0, 0, 1]);
    expect([...canopyMask(chm, green, building)]).toEqual([1, 0, 0, 1, 0]);
  });

  it('rasterizeBuildings marks cell centres inside a footprint and honours holes', () => {
    const grid: Grid = { width: 10, height: 10, originX: 0, originY: 20, cellM: 2 };
    const square = (a: number, b: number): number[][] => [
      [a, a, 0],
      [b, a, 0],
      [b, b, 0],
      [a, b, 0],
      [a, a, 0],
    ];
    const feature = {
      type: 'Feature',
      properties: {
        id: 'way/1',
        kind: 'house',
        name: null,
        heightM: 5,
        levels: null,
        source: 'type-table',
        osmTags: {},
      },
      geometry: { type: 'Polygon', coordinates: [square(4, 16), square(8, 12)] },
    } as unknown as BuildingFeature;
    const mask = rasterizeBuildings([feature], grid);
    const at = (x: number, y: number): number =>
      mask[Math.floor((grid.originY - y) / 2) * grid.width + Math.floor(x / 2)] as number;
    expect(at(5, 15)).toBe(1);
    expect(at(18, 5)).toBe(0); // outside
    expect(at(9, 11)).toBe(0); // inside the hole
    expect(at(1, 1)).toBe(0);
  });
});

/** A flat patch of w by h cells, every cell canopy, bare earth at 100 m. */
function patch(w: number, h: number, chmAt: (r: number, c: number) => number) {
  const grid: Grid = { width: w, height: h, originX: 0, originY: h * 2, cellM: 2 };
  const chm = new Float32Array(w * h);
  for (let r = 0; r < h; r += 1) for (let c = 0; c < w; c += 1) chm[r * w + c] = chmAt(r, c);
  const mask = new Uint8Array(w * h).fill(1);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i += 1) {
    rgb[i * 3] = 40;
    rgb[i * 3 + 1] = 100;
    rgb[i * 3 + 2] = 60;
  }
  return { grid, chm, mask, rgb, groundAt: () => 100 };
}

describe('placeTrees', () => {
  const smooth = patch(60, 60, () => 12);

  it('is deterministic: the same input and seed give byte-identical records', () => {
    const a = packTrees(placeTrees(smooth, { seed: 30, density: 0.85 }));
    const b = packTrees(placeTrees(smooth, { seed: 30, density: 0.85 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a.byteLength).toBeGreaterThan(0);
  });

  it('a different seed changes the jitter', () => {
    const a = placeTrees(smooth, { seed: 30, density: 1 });
    const b = placeTrees(smooth, { seed: 31, density: 1 });
    expect(a.length).toBe(b.length);
    expect(a.some((t, i) => t.east !== (b[i] as TreeRecord).east)).toBe(true);
  });

  it('keeps about the density share of the candidate blocks, and never exceeds 1.5 m of jitter from the block centre', () => {
    const all = placeTrees(smooth, { density: 1 });
    expect(all.length).toBe((60 / BLOCK_CELLS) * (60 / BLOCK_CELLS));
    const kept = placeTrees(smooth, { density: 0.6 }).length;
    expect(kept / all.length).toBeGreaterThan(0.5);
    expect(kept / all.length).toBeLessThan(0.7);
    for (const t of all) {
      const centre = (Math.floor(t.east / 6) + 0.5) * 6;
      expect(Math.abs(t.east - centre)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  it('lowering density removes trees without moving the others', () => {
    const all = new Map(placeTrees(smooth, { density: 1 }).map((t) => [`${t.east}_${t.north}`, t]));
    for (const t of placeTrees(smooth, { density: 0.5 }))
      expect(all.has(`${t.east}_${t.north}`)).toBe(true);
  });

  it('assigns conifers mostly on a peaky canopy and broadleaf mostly on a smooth one', () => {
    const smoothShare = countTrees(placeTrees(smooth, { density: 1 }));
    const peaky = patch(90, 90, (r, c) => (r % 3 === 1 && c % 3 === 1 ? 17 : 12));
    const peakyShare = countTrees(placeTrees(peaky, { density: 1 }));
    const total = (s: { types: { broadleaf: number; conifer: number } }): number =>
      s.types.broadleaf + s.types.conifer;
    expect(smoothShare.types.conifer / total(smoothShare)).toBeLessThan(0.15);
    expect(peakyShare.types.conifer / total(peakyShare)).toBeGreaterThan(0.7);
    // Broadleaf archetypes are 0 to 3, conifers 4 and 5, and every archetype id is used on a big enough patch.
    expect(smoothShare.archetypes.slice(0, 4).every((n) => n > 0)).toBe(true);
    expect(peakyShare.archetypes.slice(4).every((n) => n > 0)).toBe(true);
  });

  it('clamps height to 3..35 m with 10 percent jitter, darkens colour 15 percent, and skips blocks with too few canopy cells', () => {
    const tall = patch(30, 30, () => 80);
    for (const t of placeTrees(tall, { density: 1 })) {
      expect(t.height).toBeGreaterThanOrEqual(35 * 0.9 - 1e-9);
      expect(t.height).toBeLessThanOrEqual(35 * 1.1 + 1e-9);
      expect(t.g).toBeCloseTo((100 / 255) * 0.85, 6);
      expect(t.groundElev).toBe(100);
    }
    const sparse = patch(30, 30, () => 12);
    sparse.mask.fill(0);
    for (let i = 0; i < 4; i += 1) sparse.mask[i] = 1; // 4 canopy cells in the first block only
    expect(placeTrees(sparse, { density: 1 })).toEqual([]);
  });

  it('mulberry32 repeats for the same seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('record packing', () => {
  it('round-trips through Float32 bytes', () => {
    const trees = placeTrees(
      patch(30, 30, () => 12),
      { density: 1 },
    );
    const back = unpackTrees(packTrees(trees).buffer as ArrayBuffer, trees.length);
    expect(back.length).toBe(trees.length);
    trees.forEach((t, i) => {
      const u = back[i] as TreeRecord;
      expect(u.east).toBeCloseTo(t.east, 4);
      expect(u.height).toBeCloseTo(t.height, 4);
      expect(u.type).toBe(t.type);
      expect(u.b).toBeCloseTo(t.b, 6);
    });
  });

  it('unpackTrees rejects a wrong byte length', () => {
    expect(() => unpackTrees(new ArrayBuffer(35), 1)).toThrow(/expected 36/);
  });

  it('the header schema rejects counts that disagree with the byte length', () => {
    expect(TreesHeaderSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe('buildNoCanopy', () => {
  it('equals bare earth on canopy cells and the surface everywhere else', () => {
    const surface = new Float32Array([130, 112, 140, 105]);
    const ground = new Float32Array([100, 100, Number.NaN, 100]);
    const mask = new Uint8Array([1, 0, 1, 0]);
    const { values, replaced } = buildNoCanopy(surface, ground, mask);
    expect([...values]).toEqual([100, 112, 140, 105]);
    expect(replaced).toBe(1);
  });
});

describe('fillCanopyHoles', () => {
  it('fills a tall non-green non-building cell among canopy, and leaves roofs, short cells and isolated cells alone', () => {
    // 3 rows by 5 columns; the centre cell (1,1) is surrounded by canopy.
    const mask = new Uint8Array([1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0]);
    const chm = new Float32Array(15).fill(10);
    const none = new Uint8Array(15);
    const filled = fillCanopyHoles(mask, chm, none, 5, 3);
    expect(filled[6]).toBe(1);
    expect(filled[4]).toBe(0); // tall but no canopy neighbours
    const roof = new Uint8Array(15);
    roof[6] = 1;
    expect(fillCanopyHoles(mask, chm, roof, 5, 3)[6]).toBe(0);
    const low = new Float32Array(15).fill(10);
    low[6] = 1;
    expect(fillCanopyHoles(mask, low, none, 5, 3)[6]).toBe(0);
    expect([...mask]).toEqual([1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0]);
  });
});

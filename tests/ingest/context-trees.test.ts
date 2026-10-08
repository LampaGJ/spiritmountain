import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  BASE_DENSITY,
  GREEN_MIN,
  INNER_M,
  OUTER_M,
  TRANSFORM_SOURCES,
  blockColour,
  blockSeed,
  keepProbability,
  mulberry32,
  placeContextTrees,
  sampleHeightfield,
  type Heightfield,
  type ImageSource,
  type LocalBox,
} from '../../scripts/ingest/context-trees';
import { ContextTreesHeaderSchema } from '../../scripts/ingest/context-trees-schema';
import * as core from '../../scripts/ingest/trees';
import { packTrees, unpackTrees } from '../../scripts/ingest/trees-schema';

describe('context-trees transform sources', () => {
  it('TRANSFORM_SOURCES is exactly the transitive repo-import closure of context-trees.ts', () => {
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
    visit('scripts/ingest/context-trees.ts');
    expect([...TRANSFORM_SOURCES].sort()).toEqual([...seen].sort());
  });
});

describe('shared conventions with trees.ts', () => {
  it('mulberry32 and blockSeed give the same streams as the core transform', () => {
    const a = mulberry32(blockSeed(12345, 53));
    const b = core.mulberry32(core.blockSeed(12345, 53));
    for (let i = 0; i < 8; i += 1) expect(a()).toBe(b());
  });
});

describe('keepProbability', () => {
  it('is the base density inside INNER_M, falls monotonically, and is 0 at OUTER_M', () => {
    expect(keepProbability(0)).toBe(BASE_DENSITY);
    expect(keepProbability(INNER_M)).toBe(BASE_DENSITY);
    expect(keepProbability(OUTER_M)).toBe(0);
    expect(keepProbability(OUTER_M + 500)).toBe(0);
    let previous = BASE_DENSITY;
    for (let r = INNER_M; r <= OUTER_M; r += 100) {
      const p = keepProbability(r);
      expect(p).toBeLessThanOrEqual(previous);
      previous = p;
    }
    const mid = keepProbability((INNER_M + OUTER_M) / 2);
    expect(mid).toBeCloseTo(BASE_DENSITY / 2, 6);
  });
});

/** A w by h pixel photo of one flat colour covering a local box. */
function photo(key: string, box: LocalBox, rgb: readonly [number, number, number]): ImageSource {
  const width = 20;
  const height = 20;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { key, box, width, height, data };
}

function flat(box: LocalBox, elev: number): Heightfield {
  const width = 4;
  const height = 4;
  return {
    width,
    height,
    originX: box.xmin,
    originY: box.ymax,
    cellX: (box.xmax - box.xmin) / width,
    cellY: (box.ymax - box.ymin) / height,
    values: new Float32Array(width * height).fill(elev),
  };
}

const FOREST: readonly [number, number, number] = [40, 100, 50];
const BARE: readonly [number, number, number] = [120, 118, 110];
const NO_EXCLUDE: LocalBox = { xmin: 0, xmax: 0, ymin: 0, ymax: 0 };

describe('blockColour', () => {
  it('reads the mean greenness and colour of the pixels under the block', () => {
    const src = photo('a', { xmin: 0, xmax: 600, ymin: 0, ymax: 600 }, FOREST);
    const c = blockColour(src, 300, 300, 30);
    expect(c).not.toBeNull();
    expect(c?.greenness).toBeCloseTo((100 - 50) / 255, 6);
    expect(c?.r).toBeCloseTo(40 / 255, 6);
  });
});

describe('sampleHeightfield', () => {
  const hf: Heightfield = {
    width: 2,
    height: 2,
    originX: 0,
    originY: 20,
    cellX: 10,
    cellY: 10,
    values: new Float32Array([0, 10, 20, 30]),
  };
  it('interpolates between cell centres and is null outside the box', () => {
    expect(sampleHeightfield(hf, 5, 15)).toBe(0);
    expect(sampleHeightfield(hf, 15, 15)).toBe(10);
    expect(sampleHeightfield(hf, 10, 10)).toBe(15);
    expect(sampleHeightfield(hf, -6, 10)).toBeNull();
    expect(sampleHeightfield(hf, 10, 26)).toBeNull();
  });
});

describe('placeContextTrees', () => {
  const box: LocalBox = { xmin: 0, xmax: 600, ymin: 0, ymax: 600 };
  const input = {
    sources: [photo('a', box, FOREST)],
    heightfields: [flat(box, 250)],
    exclude: NO_EXCLUDE,
  };

  it('is deterministic: the same input gives byte-identical records', () => {
    const a = packTrees(placeContextTrees(input).trees);
    const b = packTrees(placeContextTrees(input).trees);
    expect(a.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('keeps about the base density of forest blocks near the centre, with height 8 to 22 m and ground from the heightfield', () => {
    const { trees, forestBlocks } = placeContextTrees(input);
    expect(forestBlocks).toBe(400);
    expect(trees.length / forestBlocks).toBeGreaterThan(BASE_DENSITY - 0.1);
    expect(trees.length / forestBlocks).toBeLessThan(BASE_DENSITY + 0.1);
    for (const t of trees) {
      expect(t.height).toBeGreaterThanOrEqual(8);
      expect(t.height).toBeLessThanOrEqual(22);
      expect(t.groundElev).toBe(250);
      expect(t.type).toBeGreaterThanOrEqual(0);
      expect(t.type).toBeLessThanOrEqual(5);
    }
  });

  it('places no tree on a bare block', () => {
    const bare = { ...input, sources: [photo('a', box, BARE)] };
    expect(GREEN_MIN).toBeGreaterThan((118 - 120) / 255);
    expect(placeContextTrees(bare).trees).toEqual([]);
  });

  it('skips blocks whose centre is inside the core window', () => {
    const exclude: LocalBox = { xmin: 0, xmax: 300, ymin: 0, ymax: 600 };
    const { trees } = placeContextTrees({ ...input, exclude });
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) expect(t.east).toBeGreaterThan(300 - 7);
    const east = placeContextTrees(input).trees.filter((t) => t.east >= 306).length;
    expect(trees.length).toBeGreaterThan(east * 0.9);
  });

  it('places nothing at or beyond OUTER_M and thins between INNER_M and OUTER_M', () => {
    const farBox = (centre: number): LocalBox => ({
      xmin: centre,
      xmax: centre + 600,
      ymin: 0,
      ymax: 600,
    });
    const count = (centre: number): number =>
      placeContextTrees({
        sources: [photo('a', farBox(centre), FOREST)],
        heightfields: [flat(farBox(centre), 250)],
        exclude: NO_EXCLUDE,
      }).trees.length;
    const inner = count(INNER_M - 700);
    const middle = count((INNER_M + OUTER_M) / 2);
    expect(inner).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(0);
    expect(count(OUTER_M + 100)).toBe(0);
  });

  it('gives a block to the first photo that holds it, so overlapping photos never double a tree', () => {
    const second = photo('b', box, FOREST);
    const one = placeContextTrees(input).trees.length;
    const two = placeContextTrees({ ...input, sources: [...input.sources, second] }).trees.length;
    expect(two).toBe(one);
  });

  it('skips a tree with no ground under it', () => {
    const away: Heightfield = flat({ xmin: 5000, xmax: 5600, ymin: 5000, ymax: 5600 }, 1);
    expect(placeContextTrees({ ...input, heightfields: [away] }).trees).toEqual([]);
  });

  it('round-trips through the shared record format', () => {
    const { trees } = placeContextTrees(input);
    const bin = packTrees(trees);
    const back = unpackTrees(new Uint8Array(bin).buffer, trees.length);
    expect(back.length).toBe(trees.length);
  });
});

describe('ContextTreesHeaderSchema', () => {
  const sha = 'a'.repeat(64);
  const header = {
    version: 1,
    count: 3,
    recordFloats: 9,
    byteOrder: 'LE',
    dtype: 'float32',
    fields: ['east', 'north', 'groundElev', 'height', 'type', 'rotation', 'r', 'g', 'b'],
    byteLength: 108,
    types: { broadleaf: 2, conifer: 1 },
    archetypes: [1, 1, 0, 0, 1, 0],
    params: {
      seed: 53,
      blockM: 30,
      greenMin: 0.055,
      greenFull: 0.11,
      baseDensity: 0.85,
      innerM: 5000,
      outerM: 10100,
      jitterM: 6,
      heightMinM: 8,
      heightMaxM: 22,
      heightJitter: 0.1,
      broadleafShare: 0.75,
      darken: 0.85,
    },
    forestBlocks: 10,
    frame: { file: 'data/frame.json', sha256: sha },
    sources: [{ path: 'data/raw/naip.jpg', sha256: sha }],
  };
  it('accepts a consistent header', () => {
    expect(ContextTreesHeaderSchema.safeParse(header).success).toBe(true);
  });
  it('rejects a byte length that is not count * 36, and class counts that do not sum', () => {
    expect(ContextTreesHeaderSchema.safeParse({ ...header, byteLength: 100 }).success).toBe(false);
    expect(
      ContextTreesHeaderSchema.safeParse({ ...header, types: { broadleaf: 1, conifer: 1 } })
        .success,
    ).toBe(false);
  });
});

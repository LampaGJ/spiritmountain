import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TreesHeaderSchema, type TreeRecord } from '../../scripts/ingest/trees-schema';
import { checkTrees, loadTrees } from '../../src/data/load-trees';

const files: Record<string, string> = {
  '/trees.json': 'data/trees.json',
  '/trees.bin': 'data/trees.bin',
  '/frame.json': 'data/frame.json',
  '/nc.json': 'data/surface/core-nocanopy.json',
  '/nc.bin': 'data/surface/core-nocanopy.f32',
};
const fakeFetch = ((url: string) => {
  const path = files[url];
  if (path === undefined) return Promise.resolve(new Response('', { status: 404 }));
  const bytes = readFileSync(path);
  return Promise.resolve(new Response(new Uint8Array(bytes)));
}) as unknown as typeof fetch;
const urls = {
  treesHeader: '/trees.json',
  treesBin: '/trees.bin',
  noCanopyHeader: '/nc.json',
  noCanopyBin: '/nc.bin',
};

describe('loadTrees on the real files', () => {
  it('loads trees and the core without canopy through their gates', async () => {
    const result = await loadTrees({ frameUrl: '/frame.json', urls, fetchImpl: fakeFetch });
    if ('error' in result.trees) throw new Error(result.trees.error);
    if ('error' in result.noCanopy) throw new Error(result.noCanopy.error);
    expect(result.trees.records.length).toBe(result.trees.header.count);
    expect(result.trees.header.count).toBeGreaterThan(50000);
    expect(result.trees.header.count).toBeLessThan(130000);
    expect(result.trees.header.byteLength).toBeLessThan(5_000_000);
    expect(result.noCanopy.heightfield.cols).toBe(result.noCanopy.header.width);
  });

  it('reports a truncated trees.bin as an error and keeps the other layer', async () => {
    const truncated = ((url: string) =>
      url === '/trees.bin'
        ? Promise.resolve(new Response(new Uint8Array(100)))
        : (fakeFetch as (u: string) => Promise<Response>)(url)) as unknown as typeof fetch;
    const result = await loadTrees({ frameUrl: '/frame.json', urls, fetchImpl: truncated });
    expect('error' in result.trees).toBe(true);
    expect('error' in result.noCanopy).toBe(false);
  });

  it('reports files that are not in the build', async () => {
    const result = await loadTrees({ frameUrl: '/frame.json', urls: {}, fetchImpl: fakeFetch });
    expect(result.trees).toEqual({ error: 'trees files are not in the build' });
    expect(result.noCanopy).toEqual({ error: 'core-nocanopy files are not in the build' });
  });
});

describe('checkTrees', () => {
  const header = TreesHeaderSchema.parse(JSON.parse(readFileSync('data/trees.json', 'utf8')));
  const good: TreeRecord = {
    east: 1, north: 2, groundElev: 3, height: 10, type: 1, rotation: 0, r: 0.1, g: 0.2, b: 0.1,
  };
  const h = { ...header, count: 1 };
  it('accepts a sane record and rejects a bad archetype, colour, height and non-finite value', () => {
    expect(() => checkTrees(h, [good])).not.toThrow();
    expect(() => checkTrees(h, [{ ...good, type: 6 }])).toThrow(/archetype/);
    expect(() => checkTrees(h, [{ ...good, g: 1.2 }])).toThrow(/colour/);
    expect(() => checkTrees(h, [{ ...good, height: 0 }])).toThrow(/height/);
    expect(() => checkTrees(h, [{ ...good, east: Number.NaN }])).toThrow(/finite/);
    expect(() => checkTrees(h, [])).toThrow(/header says 1/);
  });
});

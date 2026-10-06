import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadTerrain } from '../../src/data/load-terrain';
import { computeMeshGrid } from '../../src/scene/heightfield';

/** Serves the committed data/ files to loadTerrain, so the real artifacts go through the real boundary parse. */
const diskFetch = (async (input: RequestInfo | URL) => {
  const bytes = await readFile(String(input));
  return new Response(bytes);
}) as typeof fetch;

const urls = {
  headerUrl: 'data/terrain.json',
  binUrl: 'data/terrain.f32',
  frameUrl: 'data/frame.json',
  fetchImpl: diskFetch,
};

describe('committed terrain data from #9', () => {
  it('loads data/terrain.json, data/frame.json and data/terrain.f32 through the loader', async () => {
    const { header, heightfield } = await loadTerrain(urls);
    expect(header.rowOrder).toBe('north-to-south');
    expect(header.byteOrder).toBe('LE');
    expect(heightfield.cols).toBe(1390);
    expect(heightfield.rows).toBe(1348);
    expect(heightfield.cellSizeEast).toBeCloseTo(5, 2);
    expect(heightfield.cellSizeNorth).toBeCloseTo(5, 2);
    expect(heightfield.data.length).toBe(1390 * 1348);
  });

  it('builds a 512 x 512 cell mesh grid from the real field', async () => {
    const { heightfield } = await loadTerrain(urls);
    const grid = computeMeshGrid(heightfield);
    expect(grid.segX).toBe(512);
    expect(grid.segY).toBe(512);
  });
});

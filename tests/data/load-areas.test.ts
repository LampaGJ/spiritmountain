/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAreas, parseAreas } from '../../src/data/load-areas';

const fixture: any = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/areas.geojson', import.meta.url)), 'utf8'),
);
const clone = (): any => structuredClone(fixture);

describe('parseAreas', () => {
  it('recombines every fixture feature into an Area as { ...properties, geometry }', () => {
    const areas = parseAreas(fixture);
    expect(areas).toHaveLength(9);
    expect(areas[0]).toEqual({
      id: 'way/1001',
      kind: 'downhill-run',
      name: 'Fixture Run',
      difficulty: 'intermediate',
      geometry: fixture.features[0].geometry,
      osmTags: fixture.features[0].properties.osmTags,
    });
  });

  it('REJECTS a top-level foreign member such as a frame record (it was ignored before Redteam V-06)', () => {
    expect(() => parseAreas({ ...clone(), frame: { anything: 1 } })).toThrow(/envelope is invalid/);
  });

  it('rejects a top-level Feature id, naming the feature', () => {
    const bad = clone();
    bad.features[0].id = 'way/1001';
    expect(() => parseAreas(bad)).toThrow(/1 invalid feature\(s\)[\s\S]*way\/1001/);
  });

  it('imports without throwing and exposes the loader entry points (the earlier .extend() shell threw at import)', () => {
    expect(typeof parseAreas).toBe('function');
    expect(typeof loadAreas).toBe('function');
  });

  it('throws on an empty collection', () => {
    expect(() => parseAreas({ type: 'FeatureCollection', features: [] })).toThrow(/envelope is invalid/);
  });

  it('throws on a renamed envelope member', () => {
    const bad = clone();
    bad.feature = bad.features;
    delete bad.features;
    expect(() => parseAreas(bad)).toThrow(/envelope is invalid/);
  });

  it('names the feature id when a property is renamed', () => {
    const bad = clone();
    bad.features[2].properties.difficulty_level = bad.features[2].properties.difficulty;
    delete bad.features[2].properties.difficulty;
    expect(() => parseAreas(bad)).toThrow(/way\/1003/);
  });

  it('names every failing feature, not only the first', () => {
    const bad = clone();
    bad.features[1].properties.kind = 'zipline';
    delete bad.features[3].properties.osmTags;
    let message = '';
    try {
      parseAreas(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('way/1002');
    expect(message).toContain('way/1004');
    expect(message).toContain('2 invalid feature(s)');
  });

  it('throws on a duplicate id', () => {
    const bad = clone();
    bad.features[4].properties.id = 'way/1001';
    expect(() => parseAreas(bad)).toThrow(/way\/1001: properties\.id: duplicate area id way\/1001/);
  });

  it('labels a feature with no usable id by its index', () => {
    const bad = clone();
    bad.features[0].properties = {};
    expect(() => parseAreas(bad)).toThrow(/features\[0\]/);
  });
});

describe('loadAreas', () => {
  const respond = (init: ResponseInit, body: string): typeof fetch => async () => new Response(body, init);

  it('parses a good response', async () => {
    const areas = await loadAreas('x', respond({ status: 200 }, JSON.stringify(fixture)));
    expect(areas).toHaveLength(9);
  });

  it('throws on a non-200 response, naming the status', async () => {
    await expect(loadAreas('x', respond({ status: 404 }, ''))).rejects.toThrow(/HTTP 404/);
  });

  it('throws on a body that is not JSON', async () => {
    await expect(loadAreas('x', respond({ status: 200 }, '<html>'))).rejects.toThrow(/not JSON/);
  });
});

import { describe, expect, it } from 'vitest';
import { loadBuildings, parseBuildings } from '../../src/data/load-buildings';

const feature = (id: string): Record<string, unknown> => ({
  type: 'Feature',
  properties: { id, kind: 'house', name: null, heightM: 6, levels: null, source: 'type-table', osmTags: {} },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
        [0, 0, 0],
      ],
    ],
  },
});
const collection = (...features: Record<string, unknown>[]) => ({ type: 'FeatureCollection', features });
const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('parseBuildings', () => {
  it('returns the features of a valid collection', () => {
    expect(parseBuildings(collection(feature('way/1'), feature('way/2')))).toHaveLength(2);
  });

  it('rejects a renamed field and names the feature id', () => {
    const bad = feature('way/99');
    const props = bad['properties'] as Record<string, unknown>;
    props['height'] = props['heightM'];
    delete props['heightM'];
    expect(() => parseBuildings(collection(feature('way/1'), bad))).toThrow(
      /1 invalid feature\(s\)[\s\S]*way\/99/,
    );
  });

  it('rejects an empty collection', () => {
    expect(() => parseBuildings(collection())).toThrow(/envelope is invalid/);
  });
});

describe('loadBuildings', () => {
  it('resolves to features', async () => {
    const result = await loadBuildings('mem://b', respond(collection(feature('way/1'))));
    expect(result).toHaveProperty('features');
  });

  it('resolves to { error } on a parse failure, an HTTP failure, and a network failure', async () => {
    const bad = await loadBuildings('mem://b', respond({ type: 'nope' }));
    expect(bad).toHaveProperty('error');
    const http = await loadBuildings('mem://b', respond({}, 404));
    expect(http).toEqual({ error: expect.stringContaining('HTTP 404') });
    const net = await loadBuildings('mem://b', (async () => {
      throw new Error('offline');
    }) as typeof fetch);
    expect(net).toEqual({ error: 'offline' });
  });
});

import { describe, expect, it } from 'vitest';
import { loadTreeStats } from '../../src/data/load-tree-stats';

const valid = {
  version: 1,
  sources: [{ path: 'data/trees.bin', sha256: 'a'.repeat(64) }],
  count: 12,
  meanLinear: { r: 0.02, g: 0.04, b: 0.01 },
  meanSrgb: { r: 0.15, g: 0.22, b: 0.1 },
};
const respond = (body: unknown, ok = true, status = 200): typeof fetch =>
  (() =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

describe('loadTreeStats', () => {
  it('parses a valid stats file', async () => {
    const result = await loadTreeStats('/t.json', respond(valid));
    expect(result).toMatchObject({ count: 12, meanLinear: { g: 0.04 } });
  });

  it('rejects a renamed field with a named reason', async () => {
    const { meanLinear, ...rest } = valid;
    const result = await loadTreeStats('/t.json', respond({ ...rest, meanLin: meanLinear }));
    expect(result).toMatchObject({ error: expect.stringContaining('meanLinear') });
  });

  it('reports an HTTP failure and a network failure', async () => {
    expect(await loadTreeStats('/t.json', respond({}, false, 404))).toEqual({
      error: '/t.json returned HTTP 404',
    });
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await loadTreeStats('/t.json', failing)).toEqual({
      error: 'could not load /t.json: offline',
    });
  });
});

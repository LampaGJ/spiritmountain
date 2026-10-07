import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadImageryStats } from '../../src/data/load-imagery-stats';

const real = JSON.parse(readFileSync('data/imagery-stats.json', 'utf8')) as Record<string, unknown>;
const respond = (body: unknown, ok = true, status = 200): typeof fetch =>
  (() => Promise.resolve({ ok, status, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

describe('loadImageryStats', () => {
  it('parses the committed stats file', async () => {
    const result = await loadImageryStats('/s.json', respond(real));
    expect('error' in result).toBe(false);
    if (!('error' in result)) expect(result.meanLinear.g).toBeGreaterThan(0);
  });

  it('rejects a renamed field with a named reason', async () => {
    const { meanLinear, ...rest } = real;
    const result = await loadImageryStats('/s.json', respond({ ...rest, meanLin: meanLinear }));
    expect(result).toMatchObject({ error: expect.stringContaining('meanLinear') });
  });

  it('reports an HTTP failure and a network failure', async () => {
    expect(await loadImageryStats('/s.json', respond({}, false, 404))).toEqual({
      error: '/s.json returned HTTP 404',
    });
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await loadImageryStats('/s.json', failing)).toEqual({
      error: 'could not load /s.json: offline',
    });
  });
});

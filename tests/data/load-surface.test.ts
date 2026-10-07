import { describe, expect, it } from 'vitest';
import { loadSurface } from '../../src/data/load-surface';
import { FRAME_URL, frameBytes, synBin, synHeader } from './synthetic-terrain';

const urls = {
  squareHeader: 'mem://square.json',
  squareBin: 'mem://square.f32',
  coreHeader: 'mem://core.json',
  coreBin: 'mem://core.f32',
};

function stub(overrides: Record<string, () => Response> = {}): typeof fetch {
  const bodies: Record<string, () => Response> = {
    [FRAME_URL]: () => new Response(frameBytes() as BodyInit),
    'mem://square.json': () => new Response(JSON.stringify(synHeader())),
    'mem://square.f32': () => new Response(synBin() as BodyInit),
    'mem://core.json': () => new Response(JSON.stringify(synHeader())),
    'mem://core.f32': () => new Response(synBin() as BodyInit),
    ...overrides,
  };
  return (async (input: RequestInfo | URL) =>
    bodies[String(input)]?.() ?? new Response('x', { status: 404 })) as typeof fetch;
}

describe('loadSurface', () => {
  it('loads both heightfields', async () => {
    const result = await loadSurface({ frameUrl: FRAME_URL, urls, fetchImpl: stub() });
    expect('error' in result.square).toBe(false);
    expect('error' in result.core).toBe(false);
    if ('heightfield' in result.square) expect(result.square.heightfield.cols).toBe(8);
  });

  it('degrades: a missing core binary leaves the square loaded', async () => {
    const result = await loadSurface({
      frameUrl: FRAME_URL,
      urls,
      fetchImpl: stub({ 'mem://core.f32': () => new Response('nope', { status: 404 }) }),
    });
    expect('heightfield' in result.square).toBe(true);
    expect('error' in result.core && result.core.error).toMatch(/surface core.*HTTP_STATUS/);
  });

  it('degrades: a bad square header leaves the core loaded', async () => {
    const result = await loadSurface({
      frameUrl: FRAME_URL,
      urls,
      fetchImpl: stub({ 'mem://square.json': () => new Response('{"version":2}') }),
    });
    expect('error' in result.square && result.square.error).toMatch(/HEADER_PARSE/);
    expect('heightfield' in result.core).toBe(true);
  });

  it('reports both layers missing when the files are not in the build', async () => {
    const result = await loadSurface({ frameUrl: FRAME_URL, urls: {}, fetchImpl: stub() });
    expect('error' in result.square && result.square.error).toMatch(/not in the build/);
    expect('error' in result.core && result.core.error).toMatch(/not in the build/);
  });
});

import { describe, expect, it } from 'vitest';
import { indexByTileKey, loadContext, loadContextTextures } from '../../src/data/load-context';
import { FRAME_URL, frameBytes, synBin, synHeader } from './synthetic-terrain';

const urls = {
  headers: { '0_1': 'mem://0_1.json', '1_0': 'mem://1_0.json', '1_1': 'mem://1_1.json' },
  bins: { '0_1': 'mem://0_1.f32', '1_0': 'mem://1_0.f32', '1_1': 'mem://1_1.f32' },
  images: { '0_1': 'mem://0_1.jpg' },
};

function stub(overrides: Record<string, () => Response> = {}): typeof fetch {
  const bodies: Record<string, () => Response> = {
    [FRAME_URL]: () => new Response(frameBytes() as BodyInit),
    'mem://0_1.json': () => new Response(JSON.stringify(synHeader())),
    'mem://0_1.f32': () => new Response(synBin() as BodyInit),
    // 1_0: header is not valid JSON of the right shape
    'mem://1_0.json': () => new Response(JSON.stringify({ version: 2 })),
    'mem://1_0.f32': () => new Response(synBin() as BodyInit),
    // 1_1: the binary is gone
    'mem://1_1.json': () => new Response(JSON.stringify(synHeader())),
    'mem://1_1.f32': () => new Response('nope', { status: 404 }),
    ...overrides,
  };
  return (async (input: RequestInfo | URL) =>
    bodies[String(input)]?.() ?? new Response('x', { status: 404 })) as typeof fetch;
}

describe('loadContext', () => {
  it('loads good tiles and lists bad or absent ones as missing, without throwing', async () => {
    const result = await loadContext({
      frameUrl: FRAME_URL,
      urls,
      tiles: [
        [0, 1],
        [1, 0],
        [1, 1],
        [2, 0],
      ],
      fetchImpl: stub(),
    });
    expect(result.tiles.map((t) => t.key)).toEqual(['0_1']);
    expect(result.tiles[0]?.imageryUrl).toBe('mem://0_1.jpg');
    expect(result.tiles[0]?.heightfield.cols).toBe(8);
    expect(result.missing.map((m) => m.key).sort()).toEqual(['1_0', '1_1', '2_0']);
    expect(result.missing.find((m) => m.key === '1_0')?.reason).toMatch(/HEADER_PARSE/);
    expect(result.missing.find((m) => m.key === '1_1')?.reason).toMatch(/HTTP_STATUS/);
    expect(result.missing.find((m) => m.key === '2_0')?.reason).toMatch(/not in the build/);
  });

  it('reports every tile missing when nothing is in the build', async () => {
    const result = await loadContext({
      frameUrl: FRAME_URL,
      urls: { headers: {}, bins: {}, images: {} },
      fetchImpl: stub(),
    });
    expect(result.tiles).toEqual([]);
    expect(result.missing).toHaveLength(12);
  });

  it('rejects a frame hash mismatch for that tile only', async () => {
    const result = await loadContext({
      frameUrl: FRAME_URL,
      urls,
      tiles: [[0, 1]],
      fetchImpl: stub({ [FRAME_URL]: () => new Response('{"version":1}') }),
    });
    expect(result.tiles).toEqual([]);
    expect(result.missing[0]?.reason).toMatch(/FRAME_PARSE/);
  });
});

describe('indexByTileKey', () => {
  it('keeps <i>_<j> files, handles negatives and ignores the replay record', () => {
    expect(
      indexByTileKey(
        {
          '../../data/context/-1_-2.json': 'a',
          '../../data/context/0_1.json': 'b',
          '../../data/context/context.replay.json': 'c',
        },
        'json',
      ),
    ).toEqual({ '-1_-2': 'a', '0_1': 'b' });
  });
});

describe('loadContextTextures', () => {
  it('reports a tile without a jpg and a tile whose texture fails, per tile', async () => {
    const tile = (key: string, imageryUrl: string | null) =>
      ({ key, imageryUrl }) as unknown as Parameters<typeof loadContextTextures>[0][number];
    const failures: string[] = [];
    const loaded: string[] = [];
    await loadContextTextures([tile('a', null), tile('b', 'mem://b.jpg'), tile('c', 'mem://c.jpg')], {
      capabilities: { getMaxAnisotropy: () => 1, maxTextureSize: 4096 },
      onTexture: (key) => loaded.push(key),
      onFailure: (key) => failures.push(key),
      loadTexture: async (url) => {
        if (url.includes('c.jpg')) throw new Error('boom');
        return { dispose() {} } as never;
      },
    });
    expect(loaded).toEqual(['b']);
    expect(failures.sort()).toEqual(['a', 'c']);
  });
});

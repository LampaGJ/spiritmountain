import { describe, expect, it, vi } from 'vitest';
import { PlacesLoadError, loadPlaces, parsePlaces } from '../../src/data/load-places';

const hex64 = 'a'.repeat(64);
const hex40 = 'b'.repeat(40);

const place = {
  id: 'grand-avenue-chalet',
  name: 'Grand Avenue Chalet',
  kind: 'chalet',
  east: 697,
  north: 618,
  radiusM: 200,
  sourceUrl: 'https://example.com/',
  verified: true,
  positionNote: 'test',
  positionSource: 'coordinates',
};

function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    frame: { sha256: hex64 },
    generatedFrom: { inputHash: hex64, codeCommit: hex40, effect: 'preserves' },
    places: [place],
    ...overrides,
  };
}

describe('parsePlaces', () => {
  it('returns the places and the frame hash of a valid file', () => {
    const parsed = parsePlaces(file());
    expect(parsed.places).toHaveLength(1);
    expect(parsed.frameSha256).toBe(hex64);
  });

  it('throws a named error on a renamed field instead of returning no places', () => {
    const renamed = file({ places: [{ ...place, nom: place.name, name: undefined }] });
    expect(() => parsePlaces(renamed)).toThrow(PlacesLoadError);
  });

  it('rejects a verified place with no position', () => {
    const bad = file({ places: [{ ...place, east: null, north: null, positionSource: 'none' }] });
    expect(() => parsePlaces(bad)).toThrow(/verified/);
  });

  it('rejects an empty places list', () => {
    expect(() => parsePlaces(file({ places: [] }))).toThrow(PlacesLoadError);
  });
});

describe('loadPlaces', () => {
  it('resolves to [] with exactly one info line when the file is not in the build', async () => {
    const info = vi.fn();
    const fetchImpl = vi.fn();
    const places = await loadPlaces({ url: undefined, frameUrl: '/frame.json', fetchImpl, info });
    expect(places).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  async function sha256(text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('loads the places when the frame hash matches', async () => {
    const frameText = '{"frame":true}';
    const body = file({ frame: { sha256: await sha256(frameText) } });
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url) === '/places.json' ? Response.json(body) : new Response(frameText),
    ) as unknown as typeof fetch;
    const places = await loadPlaces({ url: '/places.json', frameUrl: '/frame.json', fetchImpl });
    expect(places.map((p) => p.name)).toEqual(['Grand Avenue Chalet']);
  });

  it('throws when the frame hash differs', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url) === '/places.json' ? Response.json(file()) : new Response('other frame'),
    ) as unknown as typeof fetch;
    await expect(loadPlaces({ url: '/places.json', frameUrl: '/frame.json', fetchImpl })).rejects.toThrow(
      /frame\.json sha256/,
    );
  });

  it('throws on an HTTP failure and on a body that is not JSON', async () => {
    const notFound = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(loadPlaces({ url: '/p', frameUrl: '/f', fetchImpl: notFound })).rejects.toThrow(/HTTP 404/);
    const notJson = vi.fn(async () => new Response('<html>')) as unknown as typeof fetch;
    await expect(loadPlaces({ url: '/p', frameUrl: '/f', fetchImpl: notJson })).rejects.toThrow(/not valid JSON/);
  });
});

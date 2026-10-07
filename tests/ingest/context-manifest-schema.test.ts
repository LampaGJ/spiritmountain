import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContextManifestSchema } from '../../scripts/ingest/context-manifest-schema';
import { tileBox } from '../../scripts/ingest/context-tiles';

const file = (kind: 'tif' | 'jpg', width: number, i: number, j: number) => ({
  path: `data/raw/context/${i}_${j}.${kind}`,
  url: 'https://example.com/exportImage',
  method: 'GET',
  params: { bbox: '1,2,3,4' },
  httpStatus: 200,
  contentType: kind === 'tif' ? 'image/tiff' : 'image/jpeg',
  fetchedAt: '2026-10-07T01:00:00.000Z',
  byteLength: 1000,
  sha256: 'a'.repeat(64),
  width,
  height: 10,
  metresPerPixel: 6950 / width,
});

const tile = (i: number, j: number) => ({
  i,
  j,
  bbox: tileBox(i, j),
  terrain: file('tif', 232, i, j),
  imagery: file('jpg', 695, i, j),
});

const manifest = (tiles: unknown[]) => ({
  version: 1,
  epsg: 26915,
  requestHeaders: { userAgent: 'x/1' },
  tiles,
});

describe('ContextManifestSchema', () => {
  it('accepts a well-formed manifest', () => {
    expect(ContextManifestSchema.safeParse(manifest([tile(1, 1), tile(-2, 0)])).success).toBe(true);
  });

  it('rejects a duplicate tile', () => {
    const r = ContextManifestSchema.safeParse(manifest([tile(1, 1), tile(1, 1)]));
    expect(r.success).toBe(false);
  });

  it('rejects a tile that is not in the table', () => {
    expect(ContextManifestSchema.safeParse(manifest([tile(5, 5)])).success).toBe(false);
    expect(ContextManifestSchema.safeParse(manifest([tile(0, 0)])).success).toBe(false);
  });

  it('rejects a bbox that is not tileBox(i, j)', () => {
    const bad = { ...tile(1, 1), bbox: { ...tileBox(1, 1), xmax: tileBox(1, 1).xmax + 1 } };
    expect(ContextManifestSchema.safeParse(manifest([bad])).success).toBe(false);
  });

  it('rejects a metresPerPixel that disagrees with bbox and width', () => {
    const bad = tile(1, 1);
    bad.terrain.metresPerPixel = 30;
    expect(ContextManifestSchema.safeParse(manifest([bad])).success).toBe(false);
  });

  it('rejects an unknown key and a bad sha256 (strict)', () => {
    expect(ContextManifestSchema.safeParse({ ...manifest([tile(1, 1)]), extra: 1 }).success).toBe(
      false,
    );
    const bad = tile(1, 1);
    bad.imagery.sha256 = 'xyz';
    expect(ContextManifestSchema.safeParse(manifest([bad])).success).toBe(false);
  });

  it('parses the pinned data/raw/context/manifest.json with 12 tiles', () => {
    const pinned = ContextManifestSchema.parse(
      JSON.parse(readFileSync('data/raw/context/manifest.json', 'utf8')),
    );
    expect(pinned.tiles).toHaveLength(12);
  });
});

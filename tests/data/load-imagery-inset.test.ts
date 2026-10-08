import { ClampToEdgeWrapping, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { loadImageryInset } from '../../src/data/load-imagery';

const caps = { getMaxAnisotropy: () => 8, maxTextureSize: 8192 };

const manifest = {
  version: 1,
  name: 'naip-inset',
  path: 'data/raw/naip-inset.jpg',
  url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage',
  method: 'GET',
  params: { compressionQuality: '75' },
  requestHeaders: { userAgent: 'spiritmountain-poc/0.1' },
  httpStatus: 200,
  contentType: 'image/jpeg',
  fetchedAt: '2026-10-08T20:00:00.000Z',
  byteLength: 10,
  sha256: 'a'.repeat(64),
  epsg: 26915,
  origin: { easting: 1000, northing: 2000 },
  bbox: { xmin: 1100, ymin: 2100, xmax: 3420, ymax: 4420 },
  localRect: { minEast: 100, minNorth: 100, maxEast: 2420, maxNorth: 2420 },
  compressionQuality: 75,
  width: 4000,
  height: 4000,
  metresPerPixel: 0.58,
};

describe('loadImageryInset', () => {
  it('reports absent, not an error, when no manifest or no url is in the build', async () => {
    const none = await loadImageryInset({ manifestJson: undefined, url: undefined, capabilities: caps });
    expect(none).toEqual({ inset: null, reason: 'no native-resolution inset is pinned', absent: true });
    const noUrl = await loadImageryInset({ manifestJson: manifest, url: undefined, capabilities: caps });
    expect(noUrl.absent).toBe(true);
  });

  it('returns the texture clamp-to-edge with max anisotropy and the manifest local rect', async () => {
    const result = await loadImageryInset({
      manifestJson: manifest,
      url: '/naip-inset.jpg',
      capabilities: caps,
      loadTexture: () => Promise.resolve(new Texture()),
    });
    expect(result.inset?.texture.wrapS).toBe(ClampToEdgeWrapping);
    expect(result.inset?.texture.wrapT).toBe(ClampToEdgeWrapping);
    expect(result.inset?.texture.anisotropy).toBe(8);
    expect(result.inset?.texture.generateMipmaps).toBe(true);
    expect(result.inset?.rect).toEqual(manifest.localRect);
  });

  it('reports a manifest that fails the schema as a failure, not as absent', async () => {
    const result = await loadImageryInset({
      manifestJson: { ...manifest, metresPerPixel: 9 },
      url: '/naip-inset.jpg',
      capabilities: caps,
      loadTexture: () => Promise.resolve(new Texture()),
    });
    expect(result.inset).toBeNull();
    expect(result.absent).toBe(false);
    expect(result.reason).toContain('metresPerPixel');
  });

  it('reports a failed image load with its reason, not as absent', async () => {
    const result = await loadImageryInset({
      manifestJson: manifest,
      url: '/naip-inset.jpg',
      capabilities: caps,
      loadTexture: () => Promise.reject(new Error('404')),
    });
    expect(result).toEqual({
      inset: null,
      reason: 'could not load /naip-inset.jpg: 404',
      absent: false,
    });
  });

  it('refuses a texture wider than the GPU limit without loading it', async () => {
    let called = false;
    const result = await loadImageryInset({
      manifestJson: manifest,
      url: '/naip-inset.jpg',
      capabilities: { ...caps, maxTextureSize: 2048 },
      loadTexture: () => {
        called = true;
        return Promise.resolve(new Texture());
      },
    });
    expect(result.inset).toBeNull();
    expect(called).toBe(false);
  });
});

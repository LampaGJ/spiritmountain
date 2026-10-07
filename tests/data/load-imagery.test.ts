import { SRGBColorSpace, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { loadImagery } from '../../src/data/load-imagery';

const caps = { getMaxAnisotropy: () => 8, maxTextureSize: 8192 };

describe('loadImagery', () => {
  it('returns the texture in sRGB with the maximum anisotropy and flipY left true', async () => {
    const result = await loadImagery({
      url: '/naip.jpg',
      capabilities: caps,
      loadTexture: () => Promise.resolve(new Texture()),
    });
    expect(result.texture?.colorSpace).toBe(SRGBColorSpace);
    expect(result.texture?.anisotropy).toBe(8);
    expect(result.texture?.flipY).toBe(true);
  });

  it('resolves to null with the reason when the load fails', async () => {
    const result = await loadImagery({
      url: '/naip.jpg',
      capabilities: caps,
      loadTexture: () => Promise.reject(new Error('404')),
    });
    expect(result).toEqual({ texture: null, reason: 'could not load /naip.jpg: 404' });
  });

  it('resolves to null when the image is wider than the GPU texture limit, without loading', async () => {
    let called = false;
    const result = await loadImagery({
      url: '/naip.jpg',
      capabilities: { ...caps, maxTextureSize: 2048 },
      expectedWidth: 4000,
      loadTexture: () => {
        called = true;
        return Promise.resolve(new Texture());
      },
    });
    expect(result.texture).toBeNull();
    expect(result.reason).toBe('image is 4000 px wide but this GPU allows 2048');
    expect(called).toBe(false);
  });
});

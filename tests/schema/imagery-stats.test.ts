import { describe, expect, it } from 'vitest';
import { ImageryStatsSchema } from '../../src/schema/imagery-stats';

const valid = () => ({
  version: 1,
  source: { path: 'data/raw/naip.jpg', sha256: 'a'.repeat(64) },
  width: 4,
  height: 3,
  pixelCount: 12,
  meanSrgb255: { r: 100, g: 110, b: 90 },
  meanLinear: { r: 0.15, g: 0.18, b: 0.13 },
});

describe('ImageryStatsSchema', () => {
  it('accepts a valid record', () => {
    expect(ImageryStatsSchema.safeParse(valid()).success).toBe(true);
  });

  it('rejects a pixelCount that is not width * height', () => {
    expect(ImageryStatsSchema.safeParse({ ...valid(), pixelCount: 13 }).success).toBe(false);
  });

  it('rejects an sRGB mean above 255 and a linear mean above 1', () => {
    expect(
      ImageryStatsSchema.safeParse({ ...valid(), meanSrgb255: { r: 256, g: 0, b: 0 } }).success,
    ).toBe(false);
    expect(
      ImageryStatsSchema.safeParse({ ...valid(), meanLinear: { r: 1.1, g: 0, b: 0 } }).success,
    ).toBe(false);
  });

  it('rejects a bad sha256 and unknown keys', () => {
    expect(
      ImageryStatsSchema.safeParse({
        ...valid(),
        source: { path: 'x', sha256: 'XYZ' },
      }).success,
    ).toBe(false);
    expect(ImageryStatsSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
  });
});

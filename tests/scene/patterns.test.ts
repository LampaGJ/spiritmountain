import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePng, type DecodedPng } from './png-decode';

const dir = new URL('../../src/scene/patterns/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('patterns.json', dir), 'utf8')) as {
  tiles: Record<
    string,
    {
      file: string;
      widthM: number;
      periodM: number;
      widthPx: number;
      heightPx: number;
      pngSha256: string;
    }
  >;
};
const TILES = [
  'downhill-run',
  'nordic-classic',
  'nordic-skate',
  'mtb-trail',
  'snowboard',
  'snowshoe',
  'fat-bike',
  'hike',
  'trail-run',
  'tubing',
  'adaptive',
] as const;

const load = (name: string): DecodedPng => decodePng(readFileSync(new URL(`${name}.png`, dir)));

/** Mean absolute per-channel difference between two rows (RGBA). */
function rowDifference(image: DecodedPng, a: number, b: number): number {
  let total = 0;
  const stride = image.width * 4;
  for (let x = 0; x < stride; x += 1) {
    total += Math.abs(
      (image.rgba[a * stride + x] as number) - (image.rgba[b * stride + x] as number),
    );
  }
  return total / stride;
}

describe('trail ribbon pattern tiles', () => {
  it('the manifest lists exactly the eleven tiles', () => {
    expect(Object.keys(manifest.tiles).sort()).toEqual([...TILES].sort());
  });

  for (const name of TILES) {
    const entry = manifest.tiles[name];
    it(`${name}.png matches the size and sha256 recorded in patterns.json`, () => {
      const bytes = readFileSync(new URL(`${name}.png`, dir));
      const image = decodePng(bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry?.pngSha256);
      expect([image.width, image.height]).toEqual([entry?.widthPx, entry?.heightPx]);
    });

    it(`${name}.png tiles along v: the last row continues into the first`, () => {
      const image = load(name);
      // Rows H-1 and 0 are neighbours across the seam, so they differ by about one row step. The bound is twice the
      // largest step between any two interior neighbours: an unbroken pattern stays inside it, a cut or blank band does not.
      let interior = 0;
      for (let y = 1; y < image.height; y += 1) {
        interior = Math.max(interior, rowDifference(image, y - 1, y));
      }
      expect(rowDifference(image, image.height - 1, 0)).toBeLessThanOrEqual(2 * interior + 1);
    });

    it(`${name}.png has no fully transparent row`, () => {
      const image = load(name);
      const stride = image.width * 4;
      for (let y = 0; y < image.height; y += 1) {
        let alpha = 0;
        for (let x = 0; x < image.width; x += 1)
          alpha += image.rgba[y * stride + x * 4 + 3] as number;
        expect(alpha, `row ${y}`).toBeGreaterThan(0);
      }
    });

    it(`${name}.png is not all transparent and not a single colour`, () => {
      const image = load(name);
      let opaque = 0;
      const seen = new Set<number>();
      for (let i = 0; i < image.rgba.length; i += 4) {
        if ((image.rgba[i + 3] as number) > 0) opaque += 1;
        seen.add(
          ((image.rgba[i] as number) << 16) |
            ((image.rgba[i + 1] as number) << 8) |
            (image.rgba[i + 2] as number),
        );
      }
      expect(opaque).toBeGreaterThan((image.width * image.height) / 2);
      expect(seen.size).toBeGreaterThan(8);
    });
  }

  it('nordic-skate rendered its feTurbulence grain (the grain filter produced varying pixels)', () => {
    const image = load('nordic-skate');
    // The vertical corduroy lines are constant along v, so any variation along v at a fixed column inside the lane
    // between strokes comes from the noise. Measure the spread of one column band over all rows.
    const stride = image.width * 4;
    const x = 128;
    const values = new Set<number>();
    for (let y = 0; y < image.height; y += 1) {
      values.add(image.rgba[y * stride + x * 4] as number);
    }
    expect(values.size).toBeGreaterThan(6);
    // And the filter output is not fully transparent anywhere in the lane centre.
    let maxAlpha = 0;
    for (let y = 0; y < image.height; y += 1) {
      maxAlpha = Math.max(maxAlpha, image.rgba[y * stride + x * 4 + 3] as number);
    }
    expect(maxAlpha).toBeGreaterThan(200);
  });

  it('gen-patterns --check reports the committed tiles are up to date', () => {
    const script = new URL('../../scripts/ui/gen-patterns.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [fileURLToPath(script), '--check'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});

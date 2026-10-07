import { describe, expect, it } from 'vitest';
import {
  CENTRE_BOX,
  CONTEXT_TILES,
  FADE_INNER_M,
  FADE_OUTER_M,
  TILE_HEIGHT_M,
  TILE_WIDTH_M,
  fadeAlpha,
  pixelSize,
  tileBox,
  tileKey,
} from '../../scripts/ingest/context-tiles';

describe('fadeAlpha', () => {
  it('is 1 at 0 and at the inner radius', () => {
    expect(fadeAlpha(0)).toBe(1);
    expect(fadeAlpha(4000)).toBe(1);
    expect(FADE_INNER_M).toBe(4000);
  });

  it('is 0 at the outer radius and beyond', () => {
    expect(FADE_OUTER_M).toBe(10100);
    expect(fadeAlpha(10100)).toBe(0);
    expect(fadeAlpha(10101)).toBe(0);
    expect(fadeAlpha(1e6)).toBe(0);
  });

  it('is 0.5 at the midpoint of the smoothstep', () => {
    expect(fadeAlpha((4000 + 10100) / 2)).toBeCloseTo(0.5, 12);
  });

  it('never rises as distance grows, and stays in (0, 1) strictly between the radii', () => {
    let previous = 1;
    for (let d = 0; d <= 11000; d += 50) {
      const alpha = fadeAlpha(d);
      expect(alpha).toBeLessThanOrEqual(previous);
      if (d > 4000 && d < 10100) {
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThan(1);
      }
      previous = alpha;
    }
  });

  it('ends inside the circle the eight ring tiles fully cover', () => {
    expect(FADE_OUTER_M).toBeLessThanOrEqual(1.5 * TILE_HEIGHT_M);
  });
});

describe('tile table and tileBox', () => {
  it('derives the tile size from the pinned box', () => {
    expect(TILE_WIDTH_M).toBe(6950);
    expect(TILE_HEIGHT_M).toBe(6740);
  });

  it('lists 12 unique tiles, none of them the centre', () => {
    expect(CONTEXT_TILES).toHaveLength(12);
    expect(new Set(CONTEXT_TILES.map(([i, j]) => tileKey(i, j))).size).toBe(12);
    expect(CONTEXT_TILES.some(([i, j]) => i === 0 && j === 0)).toBe(false);
  });

  it('places the north-east corner of (1,1) one tile width and height from the centre tile corner', () => {
    const ne = tileBox(1, 1);
    expect(ne.xmax).toBe(CENTRE_BOX.xmax + TILE_WIDTH_M);
    expect(ne.ymax).toBe(CENTRE_BOX.ymax + TILE_HEIGHT_M);
    expect(ne.xmin).toBe(CENTRE_BOX.xmax);
    expect(ne.ymin).toBe(CENTRE_BOX.ymax);
  });

  it('returns the centre box for (0,0) and a south-west offset for (-1,-1)', () => {
    expect(tileBox(0, 0)).toEqual(CENTRE_BOX);
    expect(tileBox(-1, -1).xmax).toBe(CENTRE_BOX.xmin);
    expect(tileBox(-1, -1).ymax).toBe(CENTRE_BOX.ymin);
  });

  it('sizes the requests: 232 x 225 at 30 m and 695 x 674 at 10 m', () => {
    expect(pixelSize(30)).toEqual({ width: 232, height: 225 });
    expect(pixelSize(10)).toEqual({ width: 695, height: 674 });
  });
});

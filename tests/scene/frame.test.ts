import { describe, expect, it } from 'vitest';
import { VERTICAL_EXAGGERATION, fromScene, toScene } from '../../src/scene/frame';

describe('frame', () => {
  it('maps east to x, north to -z, elevation to y times the exaggeration', () => {
    expect(toScene(100, 200, 300)).toEqual({ x: 100, y: 300 * VERTICAL_EXAGGERATION, z: -200 });
  });

  it('round-trips through fromScene', () => {
    const p = toScene(12.5, -40, 250);
    const back = fromScene(p.x, p.y, p.z);
    expect(back.east).toBe(12.5);
    expect(back.north).toBeCloseTo(-40, 12);
    expect(back.elevation).toBeCloseTo(250, 12);
  });

  it('ships with an exaggeration of 1', () => {
    expect(VERTICAL_EXAGGERATION).toBe(1);
  });
});

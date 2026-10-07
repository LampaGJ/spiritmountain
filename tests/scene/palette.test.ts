import { describe, expect, it } from 'vitest';
import { differenceCiede2000, wcagContrast } from 'culori';
import { ActivitySchema } from '../../src/schema/annotation';
import { HIGHLIGHT_COLOR } from '../../src/scene/highlight';
import { SPORT_COLOR, TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR } from '../../src/scene/palette';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const sports = ActivitySchema.options;
const deltaE = differenceCiede2000();

describe('palette', () => {
  it('has exactly one colour for each of the twelve activities, and no others', () => {
    expect(sports).toHaveLength(12);
    expect(new Set(Object.keys(SPORT_COLOR))).toEqual(new Set(sports));
  });

  it('keeps lift-ride at the old lift yellow', () => {
    expect(SPORT_COLOR['lift-ride']).toBe(0xf0e442);
  });

  it('gives every activity a distinct colour', () => {
    expect(new Set(Object.values(SPORT_COLOR)).size).toBe(12);
  });

  it.each(sports)(
    '%s reaches 3:1 contrast (WCAG 1.4.11) against both terrain base colours',
    (sport) => {
      for (const terrain of [TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR]) {
        expect(wcagContrast(hex(SPORT_COLOR[sport]), hex(terrain))).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it('keeps every pair of activities at least 15 CIEDE2000 apart', () => {
    for (let i = 0; i < sports.length; i += 1) {
      for (let j = i + 1; j < sports.length; j += 1) {
        const a = sports[i] as (typeof sports)[number];
        const b = sports[j] as (typeof sports)[number];
        expect(
          deltaE(hex(SPORT_COLOR[a]), hex(SPORT_COLOR[b])),
          `${a} vs ${b}`,
        ).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it.each(sports)(
    '%s is at least 15 CIEDE2000 from the highlight colour (no near-white)',
    (sport) => {
      expect(deltaE(hex(SPORT_COLOR[sport]), hex(HIGHLIGHT_COLOR))).toBeGreaterThanOrEqual(15);
    },
  );

  it('keeps alpine-ski and nordic-classic at least 40 CIEDE2000 apart', () => {
    const d = deltaE(hex(SPORT_COLOR['alpine-ski']), hex(SPORT_COLOR['nordic-classic']));
    expect(d).toBeGreaterThanOrEqual(40);
  });

  it('the contrast instrument can fail: a dark blue fails 3:1 against the terrain', () => {
    expect(wcagContrast('#0072b2', hex(TERRAIN_FLAT_COLOR))).toBeLessThan(3);
  });
});

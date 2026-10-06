import { describe, expect, it } from 'vitest';
import { differenceCiede2000, wcagContrast } from 'culori';
import { AreaKindSchema } from '../../src/schema/area';
import { AREA_KIND_COLOR, TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR } from '../../src/scene/palette';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const kinds = AreaKindSchema.options;
const deltaE = differenceCiede2000();

describe('palette', () => {
  it('has exactly one colour for each of the six kinds, and no others', () => {
    expect(kinds).toHaveLength(6);
    expect(Object.keys(AREA_KIND_COLOR).sort()).toEqual([...kinds].sort());
  });

  it('gives every kind a distinct colour', () => {
    expect(new Set(Object.values(AREA_KIND_COLOR)).size).toBe(6);
  });

  it.each(kinds)(
    '%s reaches 3:1 contrast (WCAG 1.4.11) against both terrain base colours',
    (kind) => {
      for (const terrain of [TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR]) {
        expect(wcagContrast(hex(AREA_KIND_COLOR[kind]), hex(terrain))).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it('keeps every pair of kinds at least 15 CIEDE2000 apart', () => {
    for (let i = 0; i < kinds.length; i += 1) {
      for (let j = i + 1; j < kinds.length; j += 1) {
        const a = hex(AREA_KIND_COLOR[kinds[i] as keyof typeof AREA_KIND_COLOR]);
        const b = hex(AREA_KIND_COLOR[kinds[j] as keyof typeof AREA_KIND_COLOR]);
        expect(deltaE(a, b)).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('keeps downhill and nordic at least 40 CIEDE2000 apart', () => {
    const d = deltaE(hex(AREA_KIND_COLOR['downhill-run']), hex(AREA_KIND_COLOR['nordic-trail']));
    expect(d).toBeGreaterThanOrEqual(40);
  });

  it('the contrast instrument can fail: a dark blue fails 3:1 against the terrain', () => {
    expect(wcagContrast('#0072b2', hex(TERRAIN_FLAT_COLOR))).toBeLessThan(3);
  });
});

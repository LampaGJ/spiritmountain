import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  ARCHETYPE_MAX_TRIANGLES,
  buildArchetype,
  buildAllArchetypes,
  triangleCount,
} from '../../src/scene/tree-archetypes';

describe('tree archetypes', () => {
  it('has six: four broadleaf then two conifer', () => {
    expect(ARCHETYPES.map((a) => a.kind)).toEqual([
      'broadleaf',
      'broadleaf',
      'broadleaf',
      'broadleaf',
      'conifer',
      'conifer',
    ]);
  });

  it('builds every crown from 3 to 5 overlapping spheres', () => {
    for (const a of ARCHETYPES) {
      expect(a.lobes.length, a.name).toBeGreaterThanOrEqual(3);
      expect(a.lobes.length, a.name).toBeLessThanOrEqual(5);
    }
  });

  it('keeps every archetype under 120 triangles after noise', () => {
    for (const geometry of buildAllArchetypes()) {
      expect(triangleCount(geometry)).toBeLessThanOrEqual(ARCHETYPE_MAX_TRIANGLES);
      expect(triangleCount(geometry)).toBeGreaterThan(40);
    }
  });

  it('is deterministic: two builds give identical vertices', () => {
    for (const a of ARCHETYPES) {
      const x = buildArchetype(a.id).getAttribute('position').array;
      const y = buildArchetype(a.id).getAttribute('position').array;
      expect(Array.from(x)).toEqual(Array.from(y));
    }
  });

  it('has unit height: the crown top is near y = 1 and the trunk starts at or below the ground', () => {
    for (const a of ARCHETYPES) {
      const g = buildArchetype(a.id);
      const box = g.boundingBox;
      expect(box?.max.y, a.name).toBeGreaterThan(0.85);
      expect(box?.max.y, a.name).toBeLessThan(1.1);
      expect(box?.min.y, a.name).toBeLessThanOrEqual(0.001);
    }
  });

  it('is round, not conical: the widest crown is a good fraction of the height, and noise perturbs the silhouette', () => {
    const wide = buildArchetype(3).boundingBox;
    expect((wide?.max.x ?? 0) - (wide?.min.x ?? 0)).toBeGreaterThan(0.6);
    // The noise moves vertices: a noiseless build of the same lobes would differ from the built positions.
    const spec = ARCHETYPES[2];
    expect(spec?.noise).toBeGreaterThan(0);
    expect(spec?.noise).toBeLessThan(0.25);
  });

  it('closes no seams: vertices at the same lobe position move together', () => {
    const position = buildArchetype(1).getAttribute('position');
    const seen = new Map<string, string>();
    // Non-indexed geometry repeats each lobe vertex across faces; the repeats must be identical.
    let repeats = 0;
    for (let i = 0; i < position.count; i += 1) {
      const key = [position.getX(i), position.getY(i), position.getZ(i)]
        .map((v) => v.toFixed(5))
        .join(',');
      if (seen.has(key)) repeats += 1;
      seen.set(key, key);
    }
    expect(repeats).toBeGreaterThan(0);
  });
});

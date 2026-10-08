import { describe, expect, it } from 'vitest';
import { TreeStatsSchema } from '../../src/schema/tree-stats';

const valid = () => ({
  version: 1,
  sources: [{ path: 'data/trees.bin', sha256: 'a'.repeat(64) }],
  count: 12,
  meanLinear: { r: 0.02, g: 0.04, b: 0.01 },
  meanSrgb: { r: 0.15, g: 0.22, b: 0.1 },
});

describe('TreeStatsSchema', () => {
  it('accepts a valid record', () => {
    expect(TreeStatsSchema.safeParse(valid()).success).toBe(true);
  });

  it('rejects a zero count, an empty source list and a mean above 1', () => {
    expect(TreeStatsSchema.safeParse({ ...valid(), count: 0 }).success).toBe(false);
    expect(TreeStatsSchema.safeParse({ ...valid(), sources: [] }).success).toBe(false);
    expect(
      TreeStatsSchema.safeParse({ ...valid(), meanLinear: { r: 1.1, g: 0, b: 0 } }).success,
    ).toBe(false);
  });

  it('rejects a bad sha256, a renamed field and unknown keys', () => {
    expect(
      TreeStatsSchema.safeParse({ ...valid(), sources: [{ path: 'x', sha256: 'XYZ' }] }).success,
    ).toBe(false);
    const { meanLinear, ...rest } = valid();
    expect(TreeStatsSchema.safeParse({ ...rest, meanLin: meanLinear }).success).toBe(false);
    expect(TreeStatsSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
  });
});

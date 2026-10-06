import type { Heightfield } from '../../src/scene/heightfield';

/** Fixture field geometry: deliberately non-square cells (10 m east, 12 m north). */
export const FIXTURE_FIELD_SPEC = {
  cols: 64,
  rows: 48,
  cellSizeEast: 10,
  cellSizeNorth: 12,
} as const;

/**
 * A deterministic ramp plus one cone, centred on the local origin.
 * Only +, -, * and Math.sqrt are used, so the values are identical on every platform.
 * Extent: east -315..315, north -282..282.
 */
export function makeFixtureField(): Heightfield {
  const { cols, rows, cellSizeEast, cellSizeNorth } = FIXTURE_FIELD_SPEC;
  const originEast = -((cols - 1) * cellSizeEast) / 2;
  const originNorth = ((rows - 1) * cellSizeNorth) / 2;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const east = originEast + c * cellSizeEast;
      const north = originNorth - r * cellSizeNorth;
      const dx = east - 60;
      const dy = north + 20;
      const cone = Math.max(0, 70 - Math.sqrt(dx * dx + dy * dy) / 3);
      data[r * cols + c] = 120 + 0.05 * east + 0.08 * north + cone;
    }
  }
  return { cols, rows, originEast, originNorth, cellSizeEast, cellSizeNorth, data };
}

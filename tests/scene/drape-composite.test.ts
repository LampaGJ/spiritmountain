import { describe, expect, it } from 'vitest';
import { DRAPE_LIFT_M, drapeLine, minClearance } from '../../src/scene/drape';
import { createMeshSurface, type Heightfield } from '../../src/scene/heightfield';
import { surfaceSampler } from '../../src/scene/surface';

/** A canopy-like core: 2 m cells, every other cell a 6 m tree crown, over a flat 100 m plain. */
function canopyField(): Heightfield {
  const cols = 41;
  const rows = 41;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = 100 + ((r + c) % 2 === 0 ? 6 : 0);
  return { cols, rows, originEast: -40, originNorth: 40, cellSizeEast: 2, cellSizeNorth: 2, data };
}

function flatField(): Heightfield {
  const cols = 41;
  const rows = 41;
  return {
    cols,
    rows,
    originEast: -100,
    originNorth: 100,
    cellSizeEast: 5,
    cellSizeNorth: 5,
    data: new Float32Array(cols * rows).fill(100),
  };
}

describe('draping on the composite surface (#36)', () => {
  const bare = createMeshSurface(flatField());
  const core = createMeshSurface(canopyField(), Number.MAX_SAFE_INTEGER);
  const composite = surfaceSampler({ core, fallback: bare });

  it('lists the layers whose mesh edges a draped line must split at, finest first', () => {
    expect(composite.edgeSurfaces).toEqual([core, bare]);
    expect(surfaceSampler({ fallback: bare }).edgeSurfaces).toEqual([bare]);
  });

  it('never dips below the canopy mesh between its own vertices, checked every 0.25 m', () => {
    const { points } = drapeLine(composite, [
      [-35, 33, 0],
      [7, -9, 0],
      [36, -30, 0],
    ]);
    expect(minClearance(composite, points, 0.25)).toBeGreaterThanOrEqual(DRAPE_LIFT_M - 1e-6);
  });
});

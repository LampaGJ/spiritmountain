import { Scene, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import type { SurfaceLoad } from '../../src/data/load-surface';
import type { LoadedTerrain } from '../../src/data/load-terrain';
import { createMeshSurface } from '../../src/scene/heightfield';
import { carveSquare, installSurface, type BoxM } from '../../src/scene/surface';
import { synHeader } from '../data/synthetic-terrain';

function field(rise: number): LoadedTerrain {
  const cols = 8;
  const rows = 8;
  const data = new Float32Array(cols * rows).fill(100);
  data[3 * cols + 3] = 100 + rise;
  return {
    header: {
      ...synHeader(),
      width: cols,
      height: rows,
      originX: -8,
      originY: 8,
      cellSizeX: 2,
      cellSizeY: 2,
    },
    heightfield: {
      cols,
      rows,
      originEast: -7,
      originNorth: 7,
      cellSizeEast: 2,
      cellSizeNorth: 2,
      data,
    },
  };
}

const imageryBox: BoxM = { west: -8, north: 8, widthM: 16, heightM: 16 };
const base: SurfaceLoad = {
  square: { error: 'none' },
  core: field(20),
};

describe('SurfaceHandle.setCoreVariant', () => {
  it('swaps the core mesh to a bare-earth heightfield, caches it, and restores the canopy one', () => {
    const handle = installSurface(new Scene(), base, {
      fadeCentre: { east: 0, north: 0 },
      imageryBox,
    });
    const mesh = handle.meshes.core as Mesh;
    const canopyGeometry = mesh.geometry;
    const spike = (): number =>
      handle.sampler(createMeshSurface(field(0).heightfield)).sample(-1, 1).height;
    const withCanopy = spike();
    expect(withCanopy).toBeGreaterThan(110);

    expect(handle.setCoreVariant('nocanopy')).toBe(false); // no layer given for the first build
    expect(handle.setCoreVariant('nocanopy', field(0))).toBe(true);
    const bareGeometry = mesh.geometry;
    expect(bareGeometry).not.toBe(canopyGeometry);
    expect(spike()).toBeLessThan(110);

    expect(handle.setCoreVariant('canopy')).toBe(true);
    expect(mesh.geometry).toBe(canopyGeometry);
    expect(spike()).toBeCloseTo(withCanopy, 9);

    // The second request for nocanopy reuses the cached geometry without a layer.
    expect(handle.setCoreVariant('nocanopy')).toBe(true);
    expect(mesh.geometry).toBe(bareGeometry);
  });

  it('reports false when there is no core mesh', () => {
    const handle = installSurface(
      new Scene(),
      { square: field(0), core: { error: 'none' } },
      {
        fadeCentre: { east: 0, north: 0 },
        imageryBox,
      },
    );
    expect(handle.setCoreVariant('nocanopy', field(0))).toBe(false);
  });
});

describe('carveSquare', () => {
  it('takes the core heights under the core footprint and leaves the rest of the square alone', () => {
    const square = {
      cols: 10,
      rows: 10,
      originEast: -18,
      originNorth: 18,
      cellSizeEast: 4,
      cellSizeNorth: 4,
      data: new Float32Array(100).fill(150),
    };
    const core = field(0).heightfield; // centres from -7 to 7, all 100 m
    const carved = carveSquare(square, core);
    const at = (r: number, c: number): number => carved.data[r * 10 + c] as number;
    expect(at(4, 4)).toBeCloseTo(100, 6); // east -2, north 2: inside the core
    expect(at(0, 0)).toBe(150); // far corner
    expect(at(4, 9)).toBe(150); // east 18 is past the core
    expect(square.data[44]).toBe(150); // the input is not mutated
  });

  it('is applied to the square mesh when the core swaps to nocanopy, and undone on the way back', () => {
    const squareLayer: LoadedTerrain = {
      header: {
        ...synHeader(),
        width: 10,
        height: 10,
        originX: -20,
        originY: 20,
        cellSizeX: 4,
        cellSizeY: 4,
      },
      heightfield: {
        cols: 10,
        rows: 10,
        originEast: -18,
        originNorth: 18,
        cellSizeEast: 4,
        cellSizeNorth: 4,
        data: new Float32Array(100).fill(150),
      },
    };
    const handle = installSurface(
      new Scene(),
      { square: squareLayer, core: field(20) },
      {
        fadeCentre: { east: 0, north: 0 },
        imageryBox,
      },
    );
    const squareMesh = handle.meshes.square as Mesh;
    const canopyGeometry = squareMesh.geometry;
    expect(handle.setCoreVariant('nocanopy', field(0))).toBe(true);
    expect(squareMesh.geometry).not.toBe(canopyGeometry);
    const ys = Array.from(squareMesh.geometry.getAttribute('position').array).filter(
      (_, i) => i % 3 === 1,
    );
    expect(Math.min(...ys)).toBeLessThan(120); // the carved cells dropped to the 100 m core
    expect(handle.setCoreVariant('canopy')).toBe(true);
    expect(squareMesh.geometry).toBe(canopyGeometry);
  });
});

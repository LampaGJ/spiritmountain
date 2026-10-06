import { describe, expect, it } from 'vitest';
import { DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, Vector3 } from 'three';
import {
  MAX_MESH_SEGMENTS,
  computeMeshGrid,
  createMeshSurface,
  sampleHeight,
  type Heightfield,
} from '../../src/scene/heightfield';
import { makeFixtureField } from '../fixtures/make-field';

/** Non-square field: 5 cols by 4 rows, cells 10 m east by 20 m north, data[0] at (100, 500). */
function makeField(fn: (east: number, north: number) => number): Heightfield {
  const cols = 5;
  const rows = 4;
  const cellSizeEast = 10;
  const cellSizeNorth = 20;
  const originEast = 100;
  const originNorth = 500;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      data[r * cols + c] = fn(originEast + c * cellSizeEast, originNorth - r * cellSizeNorth);
    }
  }
  return { cols, rows, originEast, originNorth, cellSizeEast, cellSizeNorth, data };
}

describe('sampleHeight', () => {
  it('returns the plane height on a flat field', () => {
    const field = makeField(() => 120);
    expect(sampleHeight(field, 117.3, 463.9).height).toBeCloseTo(120, 5);
    expect(sampleHeight(field, 100, 500).height).toBeCloseTo(120, 5);
  });

  it('interpolates a ramp in east at a non-grid point', () => {
    const field = makeField((east) => 2 * east);
    expect(sampleHeight(field, 117.3, 463.9).height).toBeCloseTo(234.6, 3);
  });

  it('interpolates a ramp in north (catches a row-order flip)', () => {
    const field = makeField((_east, north) => 3 * north);
    expect(sampleHeight(field, 117.3, 463.9).height).toBeCloseTo(1391.7, 2);
  });

  it('puts data[0] at the origin and the last sample at the south-east corner', () => {
    const field = makeField((east, north) => east * 1000 + north);
    expect(sampleHeight(field, 100, 500).height).toBe(field.data[0]);
    expect(sampleHeight(field, 140, 440).height).toBe(field.data[field.data.length - 1]);
  });

  it('clamps outside the field, reports it, and does not report the exact edge', () => {
    const field = makeField((east) => east);
    const outside = sampleHeight(field, 500, 463.9);
    expect(outside.clamped).toBe(true);
    expect(outside.height).toBeCloseTo(140, 3);
    expect(sampleHeight(field, 140, 463.9).clamped).toBe(false);
    expect(sampleHeight(field, 100, 500).clamped).toBe(false);
    expect(sampleHeight(field, 99.9, 500).clamped).toBe(true);
  });

  it('rejects a field whose data length does not match cols * rows', () => {
    const field = { ...makeField(() => 1), data: new Float32Array(3) };
    expect(() => sampleHeight(field, 100, 500)).toThrow(/data length 3/);
  });
});

describe('computeMeshGrid', () => {
  it('uses stride 1 when the field is within the segment cap', () => {
    const grid = computeMeshGrid(makeFixtureField());
    expect(grid).toEqual({ segX: 63, segY: 47, strideX: 1, strideY: 1 });
  });

  it('subsamples a field larger than MAX_MESH_SEGMENTS', () => {
    const big: Heightfield = {
      cols: 2001,
      rows: 1001,
      originEast: 0,
      originNorth: 0,
      cellSizeEast: 2,
      cellSizeNorth: 2,
      data: new Float32Array(2001 * 1001),
    };
    const grid = computeMeshGrid(big);
    expect(MAX_MESH_SEGMENTS).toBe(512);
    expect(grid.segX).toBe(512);
    expect(grid.segY).toBe(512);
    expect(grid.strideX).toBeCloseTo(2000 / 512, 10);
    expect(grid.strideY).toBeCloseTo(1000 / 512, 10);
  });
});

/** Independent oracle: the real three.js mesh built the way #11 builds it. */
function raycastHeight(
  surface: ReturnType<typeof createMeshSurface>,
  east: number,
  north: number,
): number {
  const { widthM, heightM, centreEast, centreNorth } = surface.extent;
  const geometry = new PlaneGeometry(widthM, heightM, surface.grid.segX, surface.grid.segY);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) pos.setY(i, surface.heights[i] as number);
  geometry.translate(centreEast, 0, -centreNorth);
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  mesh.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(east, 5000, -north), new Vector3(0, -1, 0));
  const hit = ray.intersectObject(mesh, false)[0];
  if (!hit) throw new Error(`no mesh hit at ${east}, ${north}`);
  return hit.point.y;
}

describe('createMeshSurface', () => {
  it.each([MAX_MESH_SEGMENTS, 16])(
    'matches a raycast against the real PlaneGeometry mesh (max %i segments)',
    (maxSegments) => {
      const surface = createMeshSurface(makeFixtureField(), maxSegments);
      let compared = 0;
      for (let east = -300; east <= 300; east += 37.3) {
        for (let north = -270; north <= 270; north += 41.7) {
          const expected = raycastHeight(surface, east, north);
          expect(surface.sample(east, north).height).toBeCloseTo(expected, 3);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(100);
    },
  );

  it('differs from the full-resolution bilinear field when subsampled, so the two instruments are not interchangeable', () => {
    const field = makeFixtureField();
    const surface = createMeshSurface(field, 16);
    let maxDiff = 0;
    for (let east = -300; east <= 300; east += 7.1) {
      for (let north = -270; north <= 270; north += 7.3) {
        maxDiff = Math.max(
          maxDiff,
          Math.abs(surface.sample(east, north).height - sampleHeight(field, east, north).height),
        );
      }
    }
    expect(maxDiff).toBeGreaterThan(0.5);
  });

  it('reports plan extent and centre of the mesh', () => {
    const { extent } = createMeshSurface(makeFixtureField());
    expect(extent.widthM).toBeCloseTo(630, 6);
    expect(extent.heightM).toBeCloseTo(564, 6);
    expect(extent.centreEast).toBeCloseTo(0, 6);
    expect(extent.centreNorth).toBeCloseTo(0, 6);
  });

  it('clamps outside the mesh and reports it', () => {
    const surface = createMeshSurface(makeFixtureField());
    expect(surface.sample(5000, 0).clamped).toBe(true);
    expect(surface.sample(0, 0).clamped).toBe(false);
  });
});

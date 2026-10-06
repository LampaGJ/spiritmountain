import { BufferAttribute, Color } from 'three';
import { describe, expect, it } from 'vitest';
import { VERTICAL_EXAGGERATION } from '../../src/scene/frame';
import {
  MAX_MESH_SEGMENTS,
  computeMeshGrid,
  createMeshSurface,
  type Heightfield,
} from '../../src/scene/heightfield';
import { TERRAIN_FLAT_COLOR, TERRAIN_STEEP_COLOR } from '../../src/scene/palette';
import { buildTerrainGeometry } from '../../src/scene/terrain';
import { FIXTURE_FIELD_SPEC, makeFixtureField } from '../fixtures/make-field';

function ramp(
  cols: number,
  rows: number,
  cellEast: number,
  cellNorth: number,
  dEast: number,
  dNorth: number,
): Heightfield {
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = 200 + dEast * c + dNorth * r;
  }
  return {
    cols,
    rows,
    originEast: -1000,
    originNorth: 2000,
    cellSizeEast: cellEast,
    cellSizeNorth: cellNorth,
    data,
  };
}

const pos = (g: ReturnType<typeof buildTerrainGeometry>) =>
  g.getAttribute('position') as BufferAttribute;

describe('terrain geometry below the mesh cap (64 x 48 fixture)', () => {
  const field = makeFixtureField();
  const geometry = buildTerrainGeometry(createMeshSurface(field));
  const p = pos(geometry);
  const { cols, rows, cellSizeEast, cellSizeNorth } = FIXTURE_FIELD_SPEC;

  it('has cols * rows vertices', () => {
    expect(p.count).toBe(cols * rows);
  });

  it('puts vertex 0 at the first sample: x = originEast, z = -originNorth', () => {
    expect(p.getX(0)).toBeCloseTo(field.originEast, 4);
    expect(p.getZ(0)).toBeCloseTo(-field.originNorth, 4);
  });

  it('spans (cols - 1) * cellSize east and (rows - 1) * cellSize north', () => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box?.max.x).toBeCloseTo(field.originEast + (cols - 1) * cellSizeEast, 4);
    expect((box?.max.x ?? 0) - (box?.min.x ?? 0)).toBeCloseTo((cols - 1) * cellSizeEast, 4);
    expect((box?.max.z ?? 0) - (box?.min.z ?? 0)).toBeCloseTo((rows - 1) * cellSizeNorth, 4);
  });

  it('puts the northmost row at the most negative z', () => {
    let minZ = Infinity;
    for (let i = 0; i < p.count; i += 1) minZ = Math.min(minZ, p.getZ(i));
    for (let c = 0; c < cols; c += 1) expect(p.getZ(c)).toBeCloseTo(minZ, 4);
    expect(p.getZ((rows - 1) * cols)).toBeGreaterThan(minZ);
  });

  it('sets world y of a known cell to its Float32 value times VERTICAL_EXAGGERATION', () => {
    const c = 10;
    const r = 7;
    expect(p.getY(r * cols + c)).toBeCloseTo(
      (field.data[r * cols + c] as number) * VERTICAL_EXAGGERATION,
      3,
    );
  });

  it('writes a colour attribute and normals', () => {
    expect(geometry.getAttribute('color').count).toBe(p.count);
    expect(geometry.getAttribute('normal').count).toBe(p.count);
  });
});

describe('terrain geometry above the mesh cap (synthetic 1200 x 900)', () => {
  const field = ramp(1200, 900, 5, 5, 0.1, 0.2);
  const surface = createMeshSurface(field);
  const geometry = buildTerrainGeometry(surface);
  const p = pos(geometry);

  it('uses the strided grid, 513 x 513 vertices', () => {
    expect(surface.grid.segX).toBe(MAX_MESH_SEGMENTS);
    expect(surface.grid.segY).toBe(MAX_MESH_SEGMENTS);
    expect(p.count).toBe((MAX_MESH_SEGMENTS + 1) * (MAX_MESH_SEGMENTS + 1));
  });

  it('keeps the mesh extent equal to the heightfield extent, edges exact', () => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect((box?.max.x ?? 0) - (box?.min.x ?? 0)).toBeCloseTo(1199 * 5, 3);
    expect((box?.max.z ?? 0) - (box?.min.z ?? 0)).toBeCloseTo(899 * 5, 3);
    expect(p.getX(0)).toBeCloseTo(-1000, 3);
    expect(p.getZ(0)).toBeCloseTo(-2000, 3);
    const last = p.count - 1;
    expect(p.getX(last)).toBeCloseTo(-1000 + 1199 * 5, 3);
    expect(p.getZ(last)).toBeCloseTo(-(2000 - 899 * 5), 3);
  });

  it('keeps corner heights equal to the first and last sample', () => {
    expect(p.getY(0)).toBeCloseTo(field.data[0] as number, 3);
    expect(p.getY(p.count - 1)).toBeCloseTo(field.data[field.data.length - 1] as number, 3);
  });
});

describe('mesh grid for the pinned 1390 x 1348 raster', () => {
  it('is 512 x 512 cells', () => {
    const grid = computeMeshGrid({
      ...ramp(2, 2, 5, 5, 0, 0),
      cols: 1390,
      rows: 1348,
      data: new Float32Array(1390 * 1348),
    });
    expect(grid.segX).toBe(512);
    expect(grid.segY).toBe(512);
  });
});

describe('slope shading', () => {
  const toLinear = (hex: number) => new Color(hex);
  it('uses the flat colour on a flat field', () => {
    const geometry = buildTerrainGeometry(createMeshSurface(ramp(8, 6, 10, 10, 0, 0)));
    const color = geometry.getAttribute('color') as BufferAttribute;
    const flat = toLinear(TERRAIN_FLAT_COLOR);
    expect(color.getX(20)).toBeCloseTo(flat.r, 5);
    expect(color.getY(20)).toBeCloseTo(flat.g, 5);
    expect(color.getZ(20)).toBeCloseTo(flat.b, 5);
  });

  it('uses the steep colour on a very steep field', () => {
    const geometry = buildTerrainGeometry(createMeshSurface(ramp(8, 6, 10, 10, 80, 0)));
    const color = geometry.getAttribute('color') as BufferAttribute;
    const steep = toLinear(TERRAIN_STEEP_COLOR);
    expect(color.getX(20)).toBeCloseTo(steep.r, 5);
    expect(color.getZ(20)).toBeCloseTo(steep.b, 5);
  });
});

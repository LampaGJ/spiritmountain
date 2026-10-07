import type { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { BUILDING_COLOR, baseElevation, buildBuildingsLayer } from '../../src/scene/buildings';
import { createMeshSurface, type Heightfield } from '../../src/scene/heightfield';
import type { BuildingFeature } from '../../src/schema/building';

/** A pure east ramp: height = 100 + 0.5 * east, exact under bilinear sampling. East -100..100, north -100..100. */
function rampField(): Heightfield {
  const cols = 21;
  const rows = 21;
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = 100 + 0.5 * (-100 + c * 10);
  }
  return {
    cols,
    rows,
    originEast: -100,
    originNorth: 100,
    cellSizeEast: 10,
    cellSizeNorth: 10,
    data,
  };
}

function square(
  id: string,
  east: number,
  north: number,
  size: number,
  heightM: number,
): BuildingFeature {
  const ring = [
    [east, north, 0],
    [east + size, north, 0],
    [east + size, north + size, 0],
    [east, north + size, 0],
    [east, north, 0],
  ];
  return {
    type: 'Feature',
    properties: {
      id,
      kind: 'house',
      name: null,
      heightM,
      levels: null,
      source: 'type-table',
      osmTags: {},
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  } as BuildingFeature;
}

const surface = createMeshSurface(rampField(), 64);

describe('buildBuildingsLayer', () => {
  it('sits on the MIN sampled terrain height and rises by heightM (scene y)', () => {
    const feature = square('way/1', 10, 20, 20, 7);
    const layer = buildBuildingsLayer([feature], surface);
    const position = layer.mesh.geometry.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      minY = Math.min(minY, position.getY(i));
      maxY = Math.max(maxY, position.getY(i));
    }
    const base = 100 + 0.5 * 10; // west edge is the lowest on an eastward ramp
    expect(baseElevation(feature.geometry.coordinates[0] as number[][], surface)).toBeCloseTo(
      base,
      3,
    );
    expect(minY).toBeCloseTo(base, 3);
    expect(maxY).toBeCloseTo(base + 7, 3);
  });

  it('maps north to -z and east to x', () => {
    const layer = buildBuildingsLayer([square('way/2', 10, 20, 20, 5)], surface);
    layer.mesh.geometry.computeBoundingBox();
    const box = layer.mesh.geometry.boundingBox;
    expect(box?.min.x).toBeCloseTo(10, 4);
    expect(box?.max.x).toBeCloseTo(30, 4);
    expect(box?.min.z).toBeCloseTo(-40, 4);
    expect(box?.max.z).toBeCloseTo(-20, 4);
  });

  it('drops a degenerate ring, counts it, and keeps the others', () => {
    const degenerate = square('way/3', 0, 0, 0, 5);
    const layer = buildBuildingsLayer([square('way/4', -50, -50, 10, 4), degenerate], surface);
    expect(layer.dropped.map((d) => d.id)).toEqual(['way/3']);
    expect(layer.dropped[0]?.reason).toMatch(/distinct/);
    expect(layer.builtCount).toBe(1);
  });

  it('merged vertex count equals the sum of the parts', () => {
    const one = buildBuildingsLayer([square('way/5', -50, -50, 10, 4)], surface);
    const two = buildBuildingsLayer([square('way/6', 30, 30, 15, 9)], surface);
    const both = buildBuildingsLayer(
      [square('way/5', -50, -50, 10, 4), square('way/6', 30, 30, 15, 9)],
      surface,
    );
    expect(both.mesh.geometry.getAttribute('position').count).toBe(
      one.mesh.geometry.getAttribute('position').count +
        two.mesh.geometry.getAttribute('position').count,
    );
  });

  it('cuts a hole from an inner ring', () => {
    const solid = square('way/7', -40, -40, 40, 5);
    const holed = structuredClone(solid);
    holed.geometry.coordinates.push([
      [-30, -30, 0],
      [-30, -10, 0],
      [-10, -10, 0],
      [-10, -30, 0],
      [-30, -30, 0],
    ]);
    const a = buildBuildingsLayer([solid], surface).mesh.geometry.getAttribute('position').count;
    const b = buildBuildingsLayer([holed], surface).mesh.geometry.getAttribute('position').count;
    expect(b).toBeGreaterThan(a);
  });

  it('uses the muted material, toggles visibility, and is not pickable', () => {
    const layer = buildBuildingsLayer([square('way/8', 0, 0, 10, 4)], surface, {
      centre: { east: 0, north: 0 },
    });
    const material = layer.mesh.material as MeshStandardMaterial;
    expect(`#${material.color.getHexString()}`).toBe(BUILDING_COLOR);
    expect(material.flatShading).toBe(true);
    expect(material.roughness).toBe(0.9);
    layer.setVisible(false);
    expect(layer.mesh.visible).toBe(false);
    layer.setVisible(true);
    expect(layer.mesh.visible).toBe(true);
    const hits: unknown[] = [];
    layer.mesh.raycast({} as never, hits as never);
    expect(hits).toEqual([]);
  });
});

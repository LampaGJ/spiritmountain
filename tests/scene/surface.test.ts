import {
  BufferAttribute,
  DataTexture,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
} from 'three';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Line2 } from 'three/addons/lines/Line2.js';
import { buildAreaLayer } from '../../src/scene/areas';
import { createMeshSurface } from '../../src/scene/heightfield';
import type { Area } from '../../src/schema/area';
import type { SurfaceLoad } from '../../src/data/load-surface';
import type { LoadedTerrain } from '../../src/data/load-terrain';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { toScene } from '../../src/scene/frame';
import {
  edgeDelta,
  headerBox,
  installSurface,
  installSurfaceAsync,
  surfaceSampler,
  SURFACE_CORE_MAX_SEGMENTS,
  SURFACE_SQUARE_MAX_SEGMENTS,
  SURFACE_LIFT_M,
  uvCrop,
  type BoxM,
} from '../../src/scene/surface';
import { synHeader } from '../data/synthetic-terrain';

/** A small loaded terrain: header origin is the NW corner of the NW pixel, samples at pixel centres. */
function fake(
  originX: number,
  originY: number,
  cols: number,
  rows: number,
  cell: number,
): LoadedTerrain {
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) data[r * cols + c] = 200 + c + 10 * r;
  return {
    header: {
      ...synHeader(),
      width: cols,
      height: rows,
      originX,
      originY,
      cellSizeX: cell,
      cellSizeY: cell,
    },
    heightfield: {
      cols,
      rows,
      originEast: originX + 0.5 * cell,
      originNorth: originY - 0.5 * cell,
      cellSizeEast: cell,
      cellSizeNorth: cell,
      data,
    },
  };
}

const square = fake(-40, 30, 20, 16, 4); // box 80 x 64
const core = fake(-12, 10, 8, 8, 2); // box 16 x 16
const surface: SurfaceLoad = { square, core };
const imageryBox: BoxM = { west: -40, north: 30, widthM: 80, heightM: 64 };
const fadeCentre = { east: 0, north: 0 };

describe('installSurface placement', () => {
  const scene = new Scene();
  const handle = installSurface(scene, surface, { fadeCentre, imageryBox });
  const squareMesh = handle.meshes.square as Mesh;
  const coreMesh = handle.meshes.core as Mesh;

  /** World position of vertex 0 (first sample centre of the NW pixel). */
  const vertex0 = (mesh: Mesh) => {
    const p = mesh.geometry.getAttribute('position') as BufferAttribute;
    return {
      x: p.getX(0) + mesh.position.x,
      y: p.getY(0) + mesh.position.y,
      z: p.getZ(0) + mesh.position.z,
    };
  };

  it('is hidden at install and toggles', () => {
    expect(handle.group.visible).toBe(false);
    handle.setVisible(true);
    expect(handle.group.visible).toBe(true);
    handle.setVisible(false);
    expect(scene.children).toContain(handle.group);
  });

  it('places the vertex at the header origin (plus half a cell) at scene x, -z, and elevation', () => {
    const at = toScene(-40 + 2, 30 - 2, 200);
    const v = vertex0(squareMesh);
    expect(v.x).toBeCloseTo(at.x, 6);
    expect(v.z).toBeCloseTo(at.z, 6);
    expect(v.y).toBeCloseTo(200 + SURFACE_LIFT_M, 4);
    const c = vertex0(coreMesh);
    expect(c.x).toBeCloseTo(-12 + 1, 6);
    expect(c.z).toBeCloseTo(-(10 - 1), 6);
  });

  it('keeps full resolution: one vertex per sample', () => {
    expect(squareMesh.geometry.getAttribute('position').count).toBe(20 * 16);
    expect(coreMesh.geometry.getAttribute('position').count).toBe(8 * 8);
  });

  it('puts the core 0.3 m above the square, which is 0.3 m above bare earth, with a stronger units-only polygon offset (#36)', () => {
    expect(squareMesh.position.y).toBeCloseTo(0.3, 9);
    expect(coreMesh.position.y - squareMesh.position.y).toBeCloseTo(0.3, 9);
    const sm = squareMesh.material as MeshStandardMaterial;
    const cm = coreMesh.material as MeshStandardMaterial;
    expect(sm.polygonOffset).toBe(true);
    expect([sm.polygonOffsetFactor, cm.polygonOffsetFactor]).toEqual([0, 0]);
    expect(cm.polygonOffsetUnits).toBeLessThan(sm.polygonOffsetUnits);
  });

  it('skips a failed layer without failing the other', () => {
    const only = installSurface(
      new Scene(),
      { square, core: { error: 'x' } },
      { fadeCentre, imageryBox },
    );
    expect(only.meshes.square).toBeDefined();
    expect(only.meshes.core).toBeUndefined();
  });

  it('shows a UV-cropped copy of the photo on each mesh only when imagery is on', () => {
    const texture = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat, UnsignedByteType);
    const h = installSurface(new Scene(), surface, { fadeCentre, imageryBox, imagery: texture });
    const cm = h.meshes.core?.material as MeshStandardMaterial;
    expect(cm.map).toBeNull();
    h.setImagery(true);
    expect(cm.map).not.toBeNull();
    expect(cm.map).not.toBe(texture);
    expect(cm.vertexColors).toBe(false);
    // core mesh box: west -11, north 9, 14 x 14 inside the 80 x 64 photo box
    expect(cm.map?.repeat.x).toBeCloseTo(14 / 80, 9);
    h.setImagery(false);
    expect(cm.map).toBeNull();
    expect(cm.vertexColors).toBe(true);
  });

  it('reports the edge delta of each mesh against the photo box', () => {
    // square mesh: west -38, east 38 (80 - 4 wide span = 76), north 28, south -32
    expect(handle.imageryDelta.square).toEqual({ west: 2, east: 2, north: 2, south: 2 });
  });
});

describe('resolution cap and lazy build', () => {
  const bigSquare = fake(-100, 10, 1100, 3, 4);
  const bigCore = fake(-100, 10, 1100, 3, 2);

  it('caps each layer at its own segment constant and leaves a field under the cap at full resolution', () => {
    // The square is capped harder than the core: the core is the resort inset where roof detail matters.
    expect(SURFACE_SQUARE_MAX_SEGMENTS).toBeLessThanOrEqual(SURFACE_CORE_MAX_SEGMENTS);
    expect(SURFACE_CORE_MAX_SEGMENTS).toBeLessThanOrEqual(1100);
    const h = installSurface(
      new Scene(),
      { square: bigSquare, core: bigCore },
      { fadeCentre, imageryBox },
    );
    expect(h.meshes.square?.geometry.getAttribute('position').count).toBe(
      (SURFACE_SQUARE_MAX_SEGMENTS + 1) * 3,
    );
    expect(h.meshes.core?.geometry.getAttribute('position').count).toBe(
      (SURFACE_CORE_MAX_SEGMENTS + 1) * 3,
    );
  });

  it('installSurfaceAsync leaves the scene untouched until called, then builds one layer per yield', async () => {
    const scene = new Scene();
    expect(scene.children).toHaveLength(0);
    let yields = 0;
    const seen: number[] = [];
    const handle = await installSurfaceAsync(
      scene,
      surface,
      { fadeCentre, imageryBox },
      async () => {
        seen.push(scene.children[0]?.children.length ?? 0);
        yields += 1;
      },
    );
    expect(yields).toBe(2);
    expect(seen).toEqual([0, 1]);
    expect(handle.group.children).toHaveLength(2);
    expect(handle.group.visible).toBe(false);
  });
});

describe('surfaceSampler and redrape', () => {
  const bare = createMeshSurface(fake(-40, 30, 20, 16, 4).heightfield);
  const h = installSurface(new Scene(), surface, { fadeCentre, imageryBox });
  const composite = h.sampler(bare);

  it('uses the core inset where it covers, the square elsewhere, and the fallback outside both', () => {
    const coreField = createMeshSurface(core.heightfield, Number.MAX_SAFE_INTEGER);
    const squareField = createMeshSurface(square.heightfield, SURFACE_SQUARE_MAX_SEGMENTS);
    expect(composite.sample(-5, 5).height).toBeCloseTo(
      coreField.sample(-5, 5).height + 2 * SURFACE_LIFT_M,
      4,
    );
    expect(composite.sample(30, -20).height).toBeCloseTo(
      squareField.sample(30, -20).height + SURFACE_LIFT_M,
      4,
    );
    const only = surfaceSampler({ fallback: bare });
    expect(only.sample(0, 0).height).toBe(bare.sample(0, 0).height);
  });

  it('moves a synthetic line up by the surface delta when re-draped and back when restored', () => {
    const area: Area = {
      id: 'way/1',
      kind: 'downhill-run',
      name: null,
      osmTags: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-30, 20],
          [30, -20],
        ],
      },
    } as unknown as Area;
    const layer = buildAreaLayer([area], bare, (e, n, z) => [e, z, -n], { width: 1, height: 1 });
    const line = layer.registry.get('way/1')?.lines[0] as Line2;
    const ys = (): number[] => {
      const start = line.geometry.getAttribute('instanceStart');
      return Array.from({ length: start.count }, (_, i) => start.getY(i));
    };
    const before = ys();
    line.visible = false;
    layer.redrape(composite);
    const after = ys();
    // The composite splits the line at the core and square mesh edges too (#36), so it gains vertices.
    expect(after.length).toBeGreaterThan(before.length);
    const expectedDelta = (e: number, n: number): number =>
      composite.sample(e, n).height - bare.sample(e, n).height;
    expect(after[0]! - before[0]!).toBeCloseTo(expectedDelta(-30, 20), 4);
    expect(after[0]! - before[0]!).toBeGreaterThan(0.2);
    expect(line.visible).toBe(false);
    expect(line.userData['areaId']).toBe('way/1');
    layer.redrape(bare);
    ys().forEach((y, i) => expect(y).toBeCloseTo(before[i]!, 4));
  });
});

describe('uvCrop', () => {
  const image: BoxM = { west: 0, north: 100, widthM: 200, heightM: 100 };

  it('is the identity for the same box', () => {
    expect(uvCrop(image, image)).toEqual({ offset: [0, 0], repeat: [1, 1] });
  });

  it('gives a north-west window offset (0, 1 - h) and repeat (w, h)', () => {
    const window: BoxM = { west: 0, north: 100, widthM: 50, heightM: 25 };
    const { offset, repeat } = uvCrop(window, image);
    expect(repeat).toEqual([0.25, 0.25]);
    expect(offset).toEqual([0, 0.75]);
  });

  it('puts a south-east window at offset (1 - w, 0)', () => {
    const window: BoxM = { west: 150, north: 25, widthM: 50, heightM: 25 };
    expect(uvCrop(window, image).offset).toEqual([0.75, 0]);
  });

  it('samples the north-west quadrant of an image-ordered checker at the window NW corner (orientation rule of terrain-imagery.test.ts)', () => {
    // Same checker and sampler convention as terrain-imagery.test.ts: flipY texture, v = 1 is the top image row, mesh NW corner at UV (0, 1).
    const RED = [255, 0, 0];
    const GREEN = [0, 255, 0];
    const BLUE = [0, 0, 255];
    const WHITE = [255, 255, 255];
    const px = [...RED, 255, ...GREEN, 255, ...BLUE, 255, ...WHITE, 255];
    const data = new Uint8Array(px);
    const sampleAt = (u: number, v: number): number[] => {
      const col = Math.min(Math.floor(u * 2), 1);
      const row = Math.min(Math.floor((1 - v) * 2), 1);
      const i = (row * 2 + col) * 4;
      return [data[i] as number, data[i + 1] as number, data[i + 2] as number];
    };
    const { offset, repeat } = uvCrop({ west: 0, north: 100, widthM: 100, heightM: 50 }, image); // NW quadrant
    const fromMesh = (u: number, v: number) =>
      sampleAt(u * repeat[0] + offset[0], v * repeat[1] + offset[1]);
    // The window's NW corner (mesh UV (0.01, 0.99), just inside) is red, its SE corner is still red: the whole quadrant is red.
    expect(fromMesh(0.01, 0.99)).toEqual(RED);
    expect(fromMesh(0.99, 0.01)).toEqual(RED);
    // The south-east quadrant window is white, the north-east green, the south-west blue.
    const se = uvCrop({ west: 100, north: 50, widthM: 100, heightM: 50 }, image);
    expect(sampleAt(0.5 * se.repeat[0] + se.offset[0], 0.5 * se.repeat[1] + se.offset[1])).toEqual(
      WHITE,
    );
    const ne = uvCrop({ west: 100, north: 100, widthM: 100, heightM: 50 }, image);
    expect(sampleAt(0.5 * ne.repeat[0] + ne.offset[0], 0.5 * ne.repeat[1] + ne.offset[1])).toEqual(
      GREEN,
    );
    const sw = uvCrop({ west: 0, north: 50, widthM: 100, heightM: 50 }, image);
    expect(sampleAt(0.5 * sw.repeat[0] + sw.offset[0], 0.5 * sw.repeat[1] + sw.offset[1])).toEqual(
      BLUE,
    );
  });
});

describe('real headers', () => {
  const read = (path: string) =>
    TerrainHeaderSchema.parse(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));
  const terrain = headerBox(read('../../data/terrain.json'));
  const sq = read('../../data/surface/square.json');
  const co = read('../../data/surface/core.json');

  it('the surface square shares the terrain box west and north edges; its header box differs only by width (reported, not asserted equal)', () => {
    const box = headerBox(sq);
    expect(box.west).toBe(terrain.west);
    expect(box.north).toBe(terrain.north);
    expect(box.heightM).toBe(terrain.heightM);
    expect(box.widthM - terrain.widthM).toBe(2);
  });

  it('every surface mesh box lies inside the photo box, so the UV crop never wraps', () => {
    for (const header of [sq, co]) {
      const box = {
        west: header.originX + 0.5 * header.cellSizeX,
        north: header.originY - 0.5 * header.cellSizeY,
        widthM: (header.width - 1) * header.cellSizeX,
        heightM: (header.height - 1) * header.cellSizeY,
      };
      const d = edgeDelta(box, terrain);
      expect(Math.min(d.west, d.east, d.north, d.south)).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});

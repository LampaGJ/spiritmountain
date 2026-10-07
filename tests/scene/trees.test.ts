import { Group, InstancedMesh, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { TreeRecord } from '../../scripts/ingest/trees-schema';
import type { LoadedTrees } from '../../src/data/load-trees';
import { toScene } from '../../src/scene/frame';
import {
  TREE_BASE_LIFT_M,
  buildInstances,
  installTrees,
  instanceAwareFadeVertex,
  treeMatrix,
} from '../../src/scene/trees';

const tree = (over: Partial<TreeRecord> = {}): TreeRecord => ({
  east: 120,
  north: 340,
  groundElev: 250,
  height: 20,
  type: 2,
  rotation: 1.2,
  r: 0.2,
  g: 0.35,
  b: 0.15,
  ...over,
});

describe('treeMatrix', () => {
  it('puts the trunk base at the scene position and the crown top one tree height above it', () => {
    const t = tree();
    const m = treeMatrix(t);
    const base = new Vector3(0, 0, 0).applyMatrix4(m);
    const top = new Vector3(0, 1, 0).applyMatrix4(m);
    const at = toScene(t.east, t.north, t.groundElev + TREE_BASE_LIFT_M);
    expect(base.x).toBeCloseTo(at.x, 9);
    expect(base.z).toBeCloseTo(at.z, 9);
    expect(base.y).toBeCloseTo(at.y, 9);
    expect(top.y - base.y).toBeCloseTo(t.height, 9);
    expect(top.x).toBeCloseTo(at.x, 9);
  });

  it('yaws by rotation: a point on +x lands rotated about the vertical, scaled by height', () => {
    const t = tree({ rotation: Math.PI / 2, height: 10 });
    const p = new Vector3(1, 0, 0).applyMatrix4(treeMatrix(t));
    const at = toScene(t.east, t.north, t.groundElev + TREE_BASE_LIFT_M);
    expect(p.x - at.x).toBeCloseTo(0, 9);
    expect(Math.abs(p.z - at.z)).toBeCloseTo(10, 9);
  });
});

describe('buildInstances', () => {
  it('groups by archetype, one matrix and one colour per tree', () => {
    const records = [tree({ type: 0 }), tree({ type: 5 }), tree({ type: 0, east: 5 })];
    const groups = buildInstances(records);
    expect(groups.map((g) => g.count)).toEqual([2, 0, 0, 0, 0, 1]);
    const first = new Matrix4().fromArray(groups[0]?.matrices as Float32Array, 16);
    expect(new Vector3().setFromMatrixPosition(first).x).toBeCloseTo(5, 4);
    // Colours are linear light: sRGB 0.35 is about 0.1, well under 0.35.
    expect(groups[0]?.colors[1]).toBeLessThan(0.15);
  });
});

describe('installTrees', () => {
  const trees: LoadedTrees = {
    header: {} as LoadedTrees['header'],
    records: [tree({ type: 0 }), tree({ type: 1 }), tree({ type: 4 }), tree({ type: 4, east: 9 })],
  };

  it('makes one InstancedMesh per archetype with trees, frustum culled, hidden until asked', () => {
    const parent = new Group();
    const handle = installTrees(parent, trees, { fadeCentre: { east: 0, north: 0 } });
    expect(handle.meshes.length).toBe(3);
    expect(handle.meshes.every((m) => m instanceof InstancedMesh && m.frustumCulled)).toBe(true);
    expect(handle.meshes.map((m) => m.count)).toEqual([1, 1, 2]);
    expect(handle.meshes.every((m) => m.instanceColor !== null)).toBe(true);
    expect(handle.meshes.every((m) => m.boundingSphere !== null)).toBe(true);
    expect(handle.group.visible).toBe(false);
    expect(parent.children).toContain(handle.group);
    handle.setVisible(true);
    expect(handle.group.visible).toBe(true);
  });

  it('dispose removes the group and frees geometries and the material', () => {
    const parent = new Group();
    const handle = installTrees(parent, trees, { fadeCentre: { east: 0, north: 0 } });
    let disposed = 0;
    for (const mesh of handle.meshes)
      mesh.geometry.addEventListener('dispose', () => (disposed += 1));
    let materialDisposed = false;
    handle.material.addEventListener('dispose', () => (materialDisposed = true));
    handle.dispose();
    expect(parent.children).not.toContain(handle.group);
    expect(disposed).toBe(3);
    expect(materialDisposed).toBe(true);
  });
});

describe('instanceAwareFadeVertex', () => {
  it('uses instanceMatrix for the fade position under USE_INSTANCING and keeps the plain path otherwise', () => {
    const source = '#include <begin_vertex>\nvFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;';
    const out = instanceAwareFadeVertex(source);
    expect(out).toContain('#ifdef USE_INSTANCING');
    expect(out).toContain('modelMatrix * instanceMatrix * vec4(transformed, 1.0)');
    expect(out).toContain('#else');
  });
});

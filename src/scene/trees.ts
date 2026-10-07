import {
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { ARCHETYPE_COUNT, type TreeRecord } from '../../scripts/ingest/trees-schema';
import type { LoadedTrees } from '../data/load-trees';
import { applyRadialFade, type RadialFadeOptions } from './fade';
import { toScene } from './frame';
import { buildAllArchetypes } from './tree-archetypes';

/** Trees stand this far above the bare-earth sample, so the trunk base is hidden in the (lifted) ground mesh. */
export const TREE_BASE_LIFT_M = 0.5;

const UP = new Vector3(0, 1, 0);

/** Writes the instance matrix of one tree: scene position from (east, north, ground + lift), yaw by rotation, uniform scale by height. */
export function treeMatrix(tree: TreeRecord, out: Matrix4 = new Matrix4()): Matrix4 {
  const position = toScene(tree.east, tree.north, tree.groundElev + TREE_BASE_LIFT_M);
  const quaternion = new Quaternion().setFromAxisAngle(UP, tree.rotation);
  return out.compose(
    new Vector3(position.x, position.y, position.z),
    quaternion,
    new Vector3(tree.height, tree.height, tree.height),
  );
}

export interface ArchetypeInstances {
  readonly count: number;
  /** 16 floats per instance, column-major, ready for InstancedMesh.instanceMatrix. */
  readonly matrices: Float32Array;
  /** Linear-light RGB per instance (the record colour is sRGB). */
  readonly colors: Float32Array;
}

/** Groups records by archetype id into instance matrix and colour arrays. Pure, so it runs in node tests. */
export function buildInstances(records: readonly TreeRecord[]): ArchetypeInstances[] {
  const counts = new Array<number>(ARCHETYPE_COUNT).fill(0);
  for (const t of records) counts[t.type] = (counts[t.type] as number) + 1;
  const out = counts.map((count) => ({
    count,
    matrices: new Float32Array(count * 16),
    colors: new Float32Array(count * 3),
  }));
  const fill = new Array<number>(ARCHETYPE_COUNT).fill(0);
  const m = new Matrix4();
  const colour = new Color();
  for (const t of records) {
    const group = out[t.type] as { matrices: Float32Array; colors: Float32Array };
    const i = fill[t.type] as number;
    treeMatrix(t, m).toArray(group.matrices, i * 16);
    colour.setRGB(t.r, t.g, t.b, SRGBColorSpace);
    group.colors[i * 3] = colour.r;
    group.colors[i * 3 + 1] = colour.g;
    group.colors[i * 3 + 2] = colour.b;
    fill[t.type] = i + 1;
  }
  return out;
}

/**
 * Makes the radial fade's world-position varying instance-aware. applyRadialFade writes
 * `vFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz`, which for an InstancedMesh is the position in the mesh frame:
 * every instance would fade by the mesh origin. The horizon blend reuses the same varying, so one patch fixes both.
 */
export function instanceAwareFadeVertex(vertexShader: string): string {
  return vertexShader.replace(
    'vFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
    '#ifdef USE_INSTANCING\nvFadeXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;\n#else\nvFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\n#endif',
  );
}

export interface InstallTreesOptions {
  readonly fadeCentre: RadialFadeOptions['centre'];
}

export interface TreesHandle {
  readonly group: Group;
  /** One InstancedMesh per archetype that has trees, in archetype order. */
  readonly meshes: readonly InstancedMesh[];
  /** The one material the six meshes share (fade patched; the caller applies the horizon blend to it). */
  readonly material: MeshStandardMaterial;
  readonly count: number;
  setVisible(on: boolean): void;
  /** Removes the group and frees the geometries, material and instance buffers. */
  dispose(): void;
}

/** Builds the six instanced archetype meshes into a hidden group under parent (the elevated group). */
export function installTrees(
  parent: Object3D,
  trees: LoadedTrees,
  options: InstallTreesOptions,
): TreesHandle {
  const group = new Group();
  group.name = 'trees';
  group.visible = false;
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  applyRadialFade(material, { centre: options.fadeCentre });
  const fadePatch = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    fadePatch.call(material, shader, renderer);
    shader.vertexShader = instanceAwareFadeVertex(shader.vertexShader);
  };
  material.customProgramCacheKey = () => 'radial-fade-instanced';
  const geometries: BufferGeometry[] = buildAllArchetypes();
  const instances = buildInstances(trees.records);
  const meshes: InstancedMesh[] = [];
  instances.forEach((inst, id) => {
    if (inst.count === 0) return;
    const mesh = new InstancedMesh(geometries[id] as BufferGeometry, material, inst.count);
    mesh.name = `trees-archetype-${id}`;
    (mesh.instanceMatrix.array as Float32Array).set(inst.matrices);
    mesh.instanceColor = new InstancedBufferAttribute(inst.colors, 3);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    group.add(mesh);
    meshes.push(mesh);
  });
  parent.add(group);
  return {
    group,
    meshes,
    material,
    count: trees.records.length,
    setVisible(on) {
      group.visible = on;
    },
    dispose() {
      parent.remove(group);
      for (const mesh of meshes) mesh.dispose();
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
}

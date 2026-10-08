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
import { ARCHETYPE_CROWN_RADIUS, buildAllArchetypes } from './tree-archetypes';

/** Trees stand this far above the bare-earth sample, so the trunk base is hidden in the (lifted) ground mesh. */
export const TREE_BASE_LIFT_M = 0.5;

/** Cell size of the uniform grid the wall segments are bucketed in for the tree cull, in metres. */
export const WALL_GRID_CELL_M = 50;

/** A trail wall set for the cull: its plan centreline and the half-width of the full set (areas.ts wallLines). */
export interface CullWall {
  readonly points: readonly (readonly [number, number])[];
  readonly halfWidthM: number;
}

/** Wall segments bucketed by grid cell: each segment is x0, y0, x1, y1, halfWidth in `segments`. */
export interface WallGrid {
  readonly cellM: number;
  readonly segments: Float64Array;
  readonly cells: ReadonlyMap<string, readonly number[]>;
  /** Largest half-width of any wall, so a query knows how many cells to look in. */
  readonly maxHalfM: number;
}

const cellKey = (ix: number, iy: number): string => `${ix},${iy}`;

/** Buckets every wall segment into each grid cell its plan bounding box touches. Pure. */
export function buildWallGrid(walls: readonly CullWall[], cellM = WALL_GRID_CELL_M): WallGrid {
  const flat: number[] = [];
  const cells = new Map<string, number[]>();
  let maxHalfM = 0;
  for (const wall of walls) {
    maxHalfM = Math.max(maxHalfM, wall.halfWidthM);
    for (let i = 0; i + 1 < wall.points.length; i += 1) {
      const a = wall.points[i] as readonly [number, number];
      const b = wall.points[i + 1] as readonly [number, number];
      const id = flat.length / 5;
      flat.push(a[0], a[1], b[0], b[1], wall.halfWidthM);
      const x0 = Math.floor(Math.min(a[0], b[0]) / cellM);
      const x1 = Math.floor(Math.max(a[0], b[0]) / cellM);
      const y0 = Math.floor(Math.min(a[1], b[1]) / cellM);
      const y1 = Math.floor(Math.max(a[1], b[1]) / cellM);
      for (let ix = x0; ix <= x1; ix += 1) {
        for (let iy = y0; iy <= y1; iy += 1) {
          const key = cellKey(ix, iy);
          const list = cells.get(key);
          if (list) list.push(id);
          else cells.set(key, [id]);
        }
      }
    }
  }
  return { cellM, segments: Float64Array.from(flat), cells, maxHalfM };
}

/** Plan distance from a point to a segment, its ends included. */
export function distanceToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(Math.max(((px - x0) * dx + (py - y0) * dy) / len2, 0), 1);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Crown radius of a tree in metres: its height (the uniform instance scale) times its archetype's unit crown reach. */
export function crownRadiusM(tree: TreeRecord): number {
  return tree.height * (ARCHETYPE_CROWN_RADIUS[tree.type] ?? 0);
}

/**
 * @displayName Tree cull at trail walls
 * @strategicPurpose Stops the forest at a trail wall's face, so no crown pokes into or through a wall (#67).
 * @tacticalObjective Drops every tree whose trunk lies within its wall set's half-width plus its own crown radius of any
 *   wall centreline segment, looking only in the grid cells that reach covers. Pure and deterministic: records keep
 *   their order, and the data files are untouched (a scene-time filter, not an ingest).
 */
export function cullTreesAtWalls(
  records: readonly TreeRecord[],
  grid: WallGrid,
): { kept: TreeRecord[]; culled: number } {
  if (grid.segments.length === 0) return { kept: [...records], culled: 0 };
  const kept: TreeRecord[] = [];
  const s = grid.segments;
  for (const tree of records) {
    const crown = crownRadiusM(tree);
    const reach = grid.maxHalfM + crown;
    const x0 = Math.floor((tree.east - reach) / grid.cellM);
    const x1 = Math.floor((tree.east + reach) / grid.cellM);
    const y0 = Math.floor((tree.north - reach) / grid.cellM);
    const y1 = Math.floor((tree.north + reach) / grid.cellM);
    let hit = false;
    for (let ix = x0; ix <= x1 && !hit; ix += 1) {
      for (let iy = y0; iy <= y1 && !hit; iy += 1) {
        for (const id of grid.cells.get(cellKey(ix, iy)) ?? []) {
          const o = id * 5;
          const d = distanceToSegment(
            tree.east,
            tree.north,
            s[o] as number,
            s[o + 1] as number,
            s[o + 2] as number,
            s[o + 3] as number,
          );
          if (d < (s[o + 4] as number) + crown) {
            hit = true;
            break;
          }
        }
      }
    }
    if (!hit) kept.push(tree);
  }
  return { kept, culled: records.length - kept.length };
}

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
  /** Group name; defaults to "trees". The far-field forest passes "context-trees". */
  readonly name?: string;
  /** Radial fade radii in metres; default to the shared fade constants. */
  readonly fadeInnerM?: number;
  readonly fadeOuterM?: number;
  /** Trail walls (#67): every tree whose crown would reach into one is dropped. Default none. */
  readonly walls?: readonly CullWall[];
}

export interface TreesHandle {
  readonly group: Group;
  /** One InstancedMesh per archetype that has trees, in archetype order. */
  readonly meshes: readonly InstancedMesh[];
  /** The one material the six meshes share (fade patched; the caller applies the horizon blend to it). */
  readonly material: MeshStandardMaterial;
  /** Trees drawn, after the wall cull. */
  readonly count: number;
  /** Trees dropped by the wall cull. */
  readonly culled: number;
  setVisible(on: boolean): void;
  /** Removes the group and frees the geometries, material and instance buffers. */
  dispose(): void;
}

/** Builds the six instanced archetype meshes into a hidden group under parent (the elevated group). */
export function installTrees(
  parent: Object3D,
  trees: Pick<LoadedTrees, 'records'>,
  options: InstallTreesOptions,
): TreesHandle {
  const group = new Group();
  const name = options.name ?? 'trees';
  group.name = name;
  group.visible = false;
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  applyRadialFade(material, {
    centre: options.fadeCentre,
    ...(options.fadeInnerM === undefined ? {} : { innerM: options.fadeInnerM }),
    ...(options.fadeOuterM === undefined ? {} : { outerM: options.fadeOuterM }),
  });
  const fadePatch = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    fadePatch.call(material, shader, renderer);
    shader.vertexShader = instanceAwareFadeVertex(shader.vertexShader);
  };
  material.customProgramCacheKey = () => 'radial-fade-instanced';
  const geometries: BufferGeometry[] = buildAllArchetypes();
  const { kept, culled } = cullTreesAtWalls(trees.records, buildWallGrid(options.walls ?? []));
  if (options.walls !== undefined) {
    console.info(`${name}: culled ${culled} of ${trees.records.length} trees at trail walls`);
  }
  const instances = buildInstances(kept);
  const meshes: InstancedMesh[] = [];
  instances.forEach((inst, id) => {
    if (inst.count === 0) return;
    const mesh = new InstancedMesh(geometries[id] as BufferGeometry, material, inst.count);
    mesh.name = `${name}-archetype-${id}`;
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
    count: kept.length,
    culled,
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

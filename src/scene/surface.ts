import {
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import type { SurfaceLayer, SurfaceLoad } from '../data/load-surface';
import type { LoadedTerrain } from '../data/load-terrain';
import type { TerrainHeader } from '../schema/terrain';
import { applyRadialFade, type RadialFadeOptions } from './fade';
import {
  createMeshSurface,
  sampleHeight,
  type Heightfield,
  type HeightSample,
  type MeshSurface,
} from './heightfield';
import { buildTerrainGeometry, setTerrainImagery } from './terrain';

/** Lift of the square above bare earth, and of the core above the square, in metres. */
export const SURFACE_LIFT_M = 0.3;

/** An axis-aligned box in local metres. */
export interface BoxM {
  readonly west: number;
  readonly north: number;
  readonly widthM: number;
  readonly heightM: number;
}

/** The box a header covers: its top-left corner origin and its full pixel extent (the NAIP export box for the terrain header). */
export function headerBox(header: TerrainHeader): BoxM {
  return {
    west: header.originX,
    north: header.originY,
    widthM: header.width * header.cellSizeX,
    heightM: header.height * header.cellSizeY,
  };
}

/** The box a mesh spans: first to last sample centre (see buildTerrainGeometry). */
export function meshBox(surface: MeshSurface): BoxM {
  const { extent } = surface;
  return {
    west: extent.centreEast - extent.widthM / 2,
    north: extent.centreNorth + extent.heightM / 2,
    widthM: extent.widthM,
    heightM: extent.heightM,
  };
}

/**
 * Texture offset and repeat that map a mesh's own UVs (0..1 over the mesh box, NW corner at (0, 1)) onto the
 * part of an image that covers `image`. Texture coordinates are uv * repeat + offset, with v = 1 at the north edge, so
 * u' = (meshWest - imageWest) / imageW + u * meshW / imageW and v' = (meshSouth - imageSouth) / imageH + v * meshH / imageH.
 * A mesh at the image's north-west corner with w by h of its size gets offset (0, 1 - h) and repeat (w, h).
 */
export function uvCrop(
  mesh: BoxM,
  image: BoxM,
): { offset: [number, number]; repeat: [number, number] } {
  const repeatX = mesh.widthM / image.widthM;
  const repeatY = mesh.heightM / image.heightM;
  const offsetX = (mesh.west - image.west) / image.widthM;
  const meshSouth = mesh.north - mesh.heightM;
  const imageSouth = image.north - image.heightM;
  const offsetY = (meshSouth - imageSouth) / image.heightM;
  return { offset: [offsetX, offsetY], repeat: [repeatX, repeatY] };
}

/** How far each edge of a mesh box lies inside (positive) or outside (negative) the image box, in metres. */
export interface EdgeDelta {
  readonly west: number;
  readonly east: number;
  readonly north: number;
  readonly south: number;
}

export function edgeDelta(mesh: BoxM, image: BoxM): EdgeDelta {
  return {
    west: mesh.west - image.west,
    east: image.west + image.widthM - (mesh.west + mesh.widthM),
    north: image.north - mesh.north,
    south: mesh.north - mesh.heightM - (image.north - image.heightM),
  };
}

/**
 * A MeshSurface whose sample() follows the drawn surface: the core inset where it covers the point, else the square, else
 * the fallback (bare earth). Each layer's own lift above bare earth is included, so a line draped on it sits on the mesh
 * that is drawn. The grid, extent and toMeshUV come from the fallback, which is only used to split lines at mesh edges.
 */
export function surfaceSampler(layers: {
  readonly square?: MeshSurface | undefined;
  readonly core?: MeshSurface | undefined;
  readonly fallback: MeshSurface;
}): MeshSurface {
  const { square, core, fallback } = layers;
  const sample = (east: number, north: number): HeightSample => {
    if (core) {
      const s = core.sample(east, north);
      if (!s.clamped) return { height: s.height + 2 * SURFACE_LIFT_M, clamped: false };
    }
    if (square) {
      const s = square.sample(east, north);
      if (!s.clamped) return { height: s.height + SURFACE_LIFT_M, clamped: false };
    }
    return fallback.sample(east, north);
  };
  // The composite keeps the fallback's grid for extent and UV maths, but a draped line must split at the edges of every
  // drawn layer (#36): splitting at the 5 m bare-earth grid alone left straight runs under a 2 m canopy mesh, which
  // rose through them and hid the trails whenever Surface was on.
  const edgeSurfaces = [core, square, fallback].filter((s): s is MeshSurface => s !== undefined);
  return { ...fallback, sample, edgeSurfaces };
}

/**
 * The square heightfield with the cells under the core's footprint replaced by the core's heights (bilinear at each cell centre).
 * The square keeps its own canopy outside the core window; inside it the canopy would otherwise rise above a canopy-free core
 * and hide the trees standing on it. Cell centres outside the core's first-to-last sample-centre extent are unchanged.
 */
export function carveSquare(square: Heightfield, core: Heightfield): Heightfield {
  const data = new Float32Array(square.data);
  const east1 = core.originEast + (core.cols - 1) * core.cellSizeEast;
  const north1 = core.originNorth - (core.rows - 1) * core.cellSizeNorth;
  for (let r = 0; r < square.rows; r += 1) {
    const north = square.originNorth - r * square.cellSizeNorth;
    if (north > core.originNorth || north < north1) continue;
    for (let c = 0; c < square.cols; c += 1) {
      const east = square.originEast + c * square.cellSizeEast;
      if (east < core.originEast || east > east1) continue;
      data[r * square.cols + c] = sampleHeight(core, east, north).height;
    }
  }
  return { ...square, data };
}

export interface InstallSurfaceOptions {
  readonly fadeCentre: RadialFadeOptions['centre'];
  /** The box the NAIP photo covers: the terrain header's box (the export bbox is the header box). */
  readonly imageryBox: BoxM;
  /** The NAIP texture the terrain uses, when it has already loaded. setTexture supplies it later otherwise. */
  readonly imagery?: Texture | null;
}

export interface SurfaceHandle {
  readonly group: Group;
  /** The meshes that were built, by layer. */
  readonly meshes: { readonly square?: Mesh; readonly core?: Mesh };
  /** Mesh box edges relative to the imagery box per layer; a negative value means the mesh reaches past the photo. */
  readonly imageryDelta: { readonly square?: EdgeDelta; readonly core?: EdgeDelta };
  /** The composite surface for draping lines: core, else square, else the given bare-earth surface. */
  sampler(fallback: MeshSurface): MeshSurface;
  /** Shows or hides the whole layer. */
  setVisible(on: boolean): void;
  /** Photo (true) or slope shading (false). */
  setImagery(on: boolean): void;
  /** Stores the shared NAIP texture; each mesh gets its own UV-cropped copy. */
  setTexture(texture: Texture): void;
  /**
   * Swaps the core mesh's heightfield, and carves the square beneath it to match. `canopy` is the surface as loaded; `nocanopy`
   * rebuilds both meshes once from the given layer (cached after that), so Trees can replace the LiDAR canopy with bare earth
   * (the square's own canopy would otherwise stand above the core and hide the trees). The sampler follows the active variant, so the
   * caller re-drapes lines afterwards. Returns false when there is no core mesh, or no layer for a first nocanopy build.
   */
  setCoreVariant(variant: 'canopy' | 'nocanopy', layer?: LoadedTerrain): boolean;
  dispose(): void;
}

/**
 * Segment caps for the surface meshes. Browser result: with #surface=on the renderer stayed unresponsive for more than
 * 45 s at 1024 (square, 1.05M vertices) plus full resolution (core, 1.56M vertices), about 5.2M triangles. A tsx profile
 * of every CPU step (mesh surface, geometry and normals, texture crop, sampler, re-drape of all 115 areas) totalled about
 * 1 s, so the cost is on the GPU side and the fix is fewer triangles: 700 segments each gives about 0.49M vertices per mesh.
 * Square: 1738 x 1685 at 4 m, stride about 2.5 (roughly 10 m). Core: 1250 x 1250 at 2 m, stride about 1.8 (roughly 3.6 m).
 */
export const SURFACE_SQUARE_MAX_SEGMENTS = 700;
export const SURFACE_CORE_MAX_SEGMENTS = 1024;

/**
 * Surface meshes: each layer capped at its own segment constant.
 * The square sits SURFACE_LIFT_M above bare earth and the core SURFACE_LIFT_M above the square, by mesh.position.y; the
 * materials also carry polygonOffset (core pulled further than square) so the near-coplanar open ground does not z-fight at range.
 */
export function installSurface(
  scene: Object3D,
  surface: SurfaceLoad,
  options: InstallSurfaceOptions,
): SurfaceHandle {
  const { handle, steps } = prepareSurface(scene, surface, options);
  for (const step of steps) step();
  return handle;
}

/**
 * Same result as installSurface, but builds one layer per step and awaits yieldToBrowser before each, so the page
 * stays responsive between the two heavy geometry builds. The empty group is in the scene (hidden) from the start.
 */
export async function installSurfaceAsync(
  scene: Object3D,
  surface: SurfaceLoad,
  options: InstallSurfaceOptions,
  yieldToBrowser: () => Promise<void>,
): Promise<SurfaceHandle> {
  const { handle, steps } = prepareSurface(scene, surface, options);
  for (const step of steps) {
    await yieldToBrowser();
    step();
  }
  return handle;
}

function prepareSurface(
  scene: Object3D,
  surface: SurfaceLoad,
  options: InstallSurfaceOptions,
): { handle: SurfaceHandle; steps: (() => void)[] } {
  const group = new Group();
  group.name = 'surface';
  group.visible = false;
  const meshes: { square?: Mesh; core?: Mesh } = {};
  const imageryDelta: { square?: EdgeDelta; core?: EdgeDelta } = {};
  const fields: { square?: MeshSurface; core?: MeshSurface } = {};
  const crops = new Map<Mesh, BoxM>();
  const coreVariants = new Map<string, { surface: MeshSurface; geometry: BufferGeometry }>();
  const squareVariants = new Map<string, { surface: MeshSurface; geometry: BufferGeometry }>();
  const textures = new Map<Mesh, Texture>();
  let imageryOn = false;
  let sourceTexture: Texture | null = null;

  const build = (name: 'square' | 'core', layer: SurfaceLayer, level: number): void => {
    if ('error' in layer) return;
    const meshSurface = createMeshSurface(
      layer.heightfield,
      name === 'square' ? SURFACE_SQUARE_MAX_SEGMENTS : SURFACE_CORE_MAX_SEGMENTS,
    );
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    // Units only, no slope term (#36): with factor -level the canopy's steep triangles were pulled toward the camera by
    // a slope-scaled depth at grazing views, far more than the 0.5 m (DRAPE_LIFT_M) the lines sit above it, so the
    // surface drew over every trail. The layers are already 0.3 m apart in metres; a constant bias is enough.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 0;
    material.polygonOffsetUnits = -level;
    const fade = applyRadialFade(material, { centre: options.fadeCentre });
    const mesh = new Mesh(buildTerrainGeometry(meshSurface) as BufferGeometry, material);
    mesh.name = `surface-${name}`;
    mesh.position.y = level * SURFACE_LIFT_M;
    mesh.userData['fade'] = fade;
    setTerrainImagery(mesh, null);
    group.add(mesh);
    meshes[name] = mesh;
    fields[name] = meshSurface;
    (name === 'core' ? coreVariants : squareVariants).set('canopy', {
      surface: meshSurface,
      geometry: mesh.geometry,
    });
    const box = meshBox(meshSurface);
    crops.set(mesh, box);
    imageryDelta[name] = edgeDelta(box, options.imageryBox);
    if (sourceTexture) {
      copyFor(mesh, box, sourceTexture);
      refresh();
    }
  };
  const steps = [() => build('square', surface.square, 1), () => build('core', surface.core, 2)];
  scene.add(group);

  const refresh = (): void => {
    for (const mesh of crops.keys()) {
      setTerrainImagery(mesh, imageryOn ? (textures.get(mesh) ?? null) : null);
    }
  };
  const copyFor = (mesh: Mesh, box: BoxM, texture: Texture): void => {
    const copy = texture.clone();
    const { offset, repeat } = uvCrop(box, options.imageryBox);
    copy.offset.set(offset[0], offset[1]);
    copy.repeat.set(repeat[0], repeat[1]);
    textures.set(mesh, copy);
  };
  const setTexture = (texture: Texture): void => {
    for (const copy of textures.values()) copy.dispose();
    textures.clear();
    sourceTexture = texture;
    for (const [mesh, box] of crops) copyFor(mesh, box, texture);
    refresh();
  };
  if (options.imagery) setTexture(options.imagery);

  const handle: SurfaceHandle = {
    group,
    meshes,
    imageryDelta,
    sampler: (fallback) => surfaceSampler({ ...fields, fallback }),
    setVisible(on) {
      group.visible = on;
    },
    setImagery(on) {
      imageryOn = on;
      refresh();
    },
    setTexture,
    setCoreVariant(variant, layer) {
      const mesh = meshes.core;
      if (!mesh) return false;
      let entry = coreVariants.get(variant);
      if (!entry) {
        if (!layer) return false;
        const built = createMeshSurface(layer.heightfield, SURFACE_CORE_MAX_SEGMENTS);
        entry = { surface: built, geometry: buildTerrainGeometry(built) };
        coreVariants.set(variant, entry);
      }
      mesh.geometry = entry.geometry;
      fields.core = entry.surface;
      const squareMesh = meshes.square;
      if (squareMesh) {
        let sq = squareVariants.get(variant);
        if (!sq && layer && !('error' in surface.square)) {
          const carved = createMeshSurface(
            carveSquare(surface.square.heightfield, layer.heightfield),
            SURFACE_SQUARE_MAX_SEGMENTS,
          );
          sq = { surface: carved, geometry: buildTerrainGeometry(carved) };
          squareVariants.set(variant, sq);
        }
        if (sq) {
          squareMesh.geometry = sq.geometry;
          fields.square = sq.surface;
        }
      }
      return true;
    },
    dispose() {
      scene.remove(group);
      for (const mesh of crops.keys()) {
        mesh.geometry.dispose();
        (mesh.material as MeshStandardMaterial).dispose();
      }
      for (const { geometry } of [...coreVariants.values(), ...squareVariants.values()]) {
        geometry.dispose();
      }
      coreVariants.clear();
      squareVariants.clear();
      for (const copy of textures.values()) copy.dispose();
      textures.clear();
      crops.clear();
    },
  };
  return { handle, steps };
}

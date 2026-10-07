import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Object3D,
  type Texture,
} from 'three';
import type { ContextTile } from '../data/load-context';
import { applyRadialFade, type RadialFadeOptions } from './fade';
import { elevationToSceneY, toScene } from './frame';
import { sampleHeight, type Heightfield } from './heightfield';
import { applySlopeColors, setTerrainImagery } from './terrain';

export interface InstallContextOptions {
  /** Fade centre in local metres (east, north). */
  readonly fadeCentre: RadialFadeOptions['centre'];
  readonly imageryOn: boolean;
}

export interface ContextHandle {
  readonly group: Group;
  /** The tile meshes by tile key, for tests and for callers that need a bounding volume. */
  readonly meshes: ReadonlyMap<string, Mesh>;
  /** Stores a tile's photo; it shows at once when imagery is on. */
  setTexture(key: string, texture: Texture): void;
  /** Shows the photos (true) or the slope shading (false) on every context tile. */
  setImagery(on: boolean): void;
  /** Removes the group and frees geometries, materials and textures. */
  dispose(): void;
}

/**
 * Displaced geometry for one tile, centred on its own origin so the mesh can sit at the tile centre.
 *
 * The 30 m grid is built on pixel CORNERS, not sample centres: vertex (c, r) is at the tile box corner
 * offset (c, r) * cell, with the height bilinearly sampled there (edge vertices clamp to the edge
 * sample). So the mesh spans exactly the tile box, adjacent tiles meet with no gap, and the NAIP jpg
 * (requested for the same box) drapes edge to edge. Orientation follows terrain.ts: PlaneGeometry row 0
 * is +y, rotateX(-PI/2) sends it to the most negative z (north), and UV (0, 1) is the north-west corner.
 */
export function buildContextGeometry(field: Heightfield): BufferGeometry {
  const segX = field.cols;
  const segY = field.rows;
  const cellE = field.cellSizeEast;
  const cellN = field.cellSizeNorth;
  const widthM = segX * cellE;
  const heightM = segY * cellN;
  const geometry = new PlaneGeometry(widthM, heightM, segX, segY);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const array = position.array as Float32Array;
  // The box's west and north edges: the first sample centre is half a cell inside them.
  const west = field.originEast - 0.5 * cellE;
  const north = field.originNorth + 0.5 * cellN;
  for (let r = 0; r <= segY; r += 1) {
    for (let c = 0; c <= segX; c += 1) {
      const { height } = sampleHeight(field, west + c * cellE, north - r * cellN);
      array[(r * (segX + 1) + c) * 3 + 1] = elevationToSceneY(height);
    }
  }
  geometry.computeVertexNormals();
  applySlopeColors(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Tile centre in local metres: the field's box centre, which is the centre tile's centre offset by (i * width, j * height). */
function tileCentre(tile: ContextTile): { east: number; north: number } {
  const { header } = tile;
  return {
    east: header.originX + (header.width * header.cellSizeX) / 2,
    north: header.originY - (header.height * header.cellSizeY) / 2,
  };
}

/**
 * Adds one fading, displaced mesh per context tile to the scene. Same material language as the centre
 * terrain (standard material, roughness 1, slope vertex colours or the photo), plus the radial fade.
 * Each mesh sits at its tile centre, so three.js sorts the transparent tiles back to front by distance.
 */
export function installContext(
  scene: Object3D,
  tiles: readonly ContextTile[],
  options: InstallContextOptions,
): ContextHandle {
  const group = new Group();
  group.name = 'context';
  const meshes = new Map<string, Mesh>();
  const textures = new Map<string, Texture>();
  let imageryOn = options.imageryOn;

  for (const tile of tiles) {
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    applyRadialFade(material, { centre: options.fadeCentre });
    const mesh = new Mesh(buildContextGeometry(tile.heightfield), material);
    mesh.name = `context-${tile.key}`;
    const centre = tileCentre(tile);
    const at = toScene(centre.east, centre.north, 0);
    mesh.position.set(at.x, 0, at.z);
    mesh.userData['tile'] = { i: tile.i, j: tile.j };
    group.add(mesh);
    meshes.set(tile.key, mesh);
    setTerrainImagery(mesh, null);
  }
  scene.add(group);

  const refresh = (key: string): void => {
    const mesh = meshes.get(key);
    if (mesh) setTerrainImagery(mesh, imageryOn ? (textures.get(key) ?? null) : null);
  };

  return {
    group,
    meshes,
    setTexture(key, texture) {
      textures.set(key, texture);
      refresh(key);
    },
    setImagery(on) {
      imageryOn = on;
      for (const key of meshes.keys()) refresh(key);
    },
    dispose() {
      scene.remove(group);
      for (const mesh of meshes.values()) {
        mesh.geometry.dispose();
        (mesh.material as MeshStandardMaterial).dispose();
      }
      for (const texture of textures.values()) texture.dispose();
      meshes.clear();
      textures.clear();
    },
  };
}

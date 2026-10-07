import {
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Shape,
  ExtrudeGeometry,
  Matrix4,
  Vector2,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingFeature } from '../schema/building';
import { applyRadialFade, type RadialFadeOptions } from './fade';
import { elevationToSceneY } from './frame';
import type { MeshSurface } from './heightfield';

/** Muted warm grey for every building. */
export const BUILDING_COLOR = '#b8b0a4';

export interface DroppedBuilding {
  readonly id: string;
  readonly reason: string;
}

export interface BuildingsLayer {
  readonly mesh: Mesh;
  /** Footprints that produced no geometry, each with the reason. */
  readonly dropped: readonly DroppedBuilding[];
  /** Footprints merged into the mesh. */
  readonly builtCount: number;
  setVisible(on: boolean): void;
}

type Ring = ReadonlyArray<ReadonlyArray<number>>;

function toPoints(ring: Ring): Vector2[] {
  // The schema guarantees a closed ring; three wants it open.
  return ring.slice(0, -1).map((p) => new Vector2(p[0] as number, p[1] as number));
}

/** Lowest terrain height sampled at the vertices of the outer ring, from the same surface the drape uses. */
export function baseElevation(ring: Ring, surface: MeshSurface): number {
  let min = Number.POSITIVE_INFINITY;
  for (const p of ring) {
    min = Math.min(min, surface.sample(p[0] as number, p[1] as number).height);
  }
  return min;
}

/**
 * One extruded footprint in scene axes (x east, y up, z = -north), baked in place.
 * Extrusion runs along shape-z; rotating about x by -90 degrees sends (x, y, z) to (x, z, -y).
 */
function extrudeOne(feature: BuildingFeature, surface: MeshSurface): ExtrudeGeometry {
  const [outer, ...holes] = feature.geometry.coordinates;
  if (outer === undefined) throw new Error('polygon has no outer ring');
  const outerPoints = toPoints(outer);
  const distinct = new Set(outerPoints.map((p) => `${p.x},${p.y}`));
  if (distinct.size < 3) throw new Error(`outer ring has ${distinct.size} distinct vertices`);
  const shape = new Shape(outerPoints);
  for (const hole of holes) {
    const path = new Shape(toPoints(hole));
    shape.holes.push(path);
  }
  const height = elevationToSceneY(feature.properties.heightM);
  const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  if (geometry.getAttribute('position').count === 0) {
    geometry.dispose();
    throw new Error('triangulation produced no faces');
  }
  const base = elevationToSceneY(baseElevation(outer, surface));
  geometry.applyMatrix4(
    new Matrix4().makeTranslation(0, base, 0).multiply(new Matrix4().makeRotationX(-Math.PI / 2)),
  );
  return geometry;
}

/**
 * @displayName Buildings layer
 * @strategicPurpose Shows where the real buildings stand on the terrain, so the resort reads as a place and not only as lines.
 * @tacticalObjective Merges one extrusion per footprint (base = lowest terrain height under the outer ring, top = base + heightM) into a single Mesh. A footprint that cannot be triangulated is skipped and listed in `dropped`.
 */
export function buildBuildingsLayer(
  features: readonly BuildingFeature[],
  surface: MeshSurface,
  fade?: RadialFadeOptions,
): BuildingsLayer {
  const parts: BufferGeometry[] = [];
  const dropped: DroppedBuilding[] = [];
  for (const feature of features) {
    try {
      const geometry = extrudeOne(feature, surface);
      geometry.deleteAttribute('uv');
      geometry.clearGroups();
      parts.push(geometry);
    } catch (error) {
      dropped.push({
        id: feature.properties.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const merged = parts.length > 0 ? mergeGeometries(parts, false) : new BufferGeometry();
  if (merged === null) throw new Error('buildings: merging the extrusions failed');
  for (const part of parts) part.dispose();

  const material: Material = new MeshStandardMaterial({
    color: BUILDING_COLOR,
    roughness: 0.9,
    flatShading: true,
  });
  if (fade) applyRadialFade(material, fade);
  const mesh = new Mesh(merged, material);
  mesh.name = 'buildings';
  // Not pickable: pick candidates come from the area registry, and this no-op keeps a stray raycast off it.
  mesh.raycast = () => {};
  return {
    mesh,
    dropped,
    builtCount: parts.length,
    setVisible(on) {
      mesh.visible = on;
    },
  };
}

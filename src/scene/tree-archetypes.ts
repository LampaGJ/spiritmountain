import { BufferAttribute, BufferGeometry, CylinderGeometry, IcosahedronGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** One crown lobe: an ellipsoid with a centre and per-axis radii, all as fractions of the tree height. */
export interface Lobe {
  readonly c: readonly [number, number, number];
  readonly r: readonly [number, number, number];
}

export interface ArchetypeSpec {
  readonly id: number;
  readonly name: string;
  readonly kind: 'broadleaf' | 'conifer';
  /** Overlapping spheres (stretched to ellipsoids): 3 to 5 per archetype. */
  readonly lobes: readonly Lobe[];
  /** Seeded vertex noise as a fraction of the lobe radius; low for broadleaf, higher for the irregular conifer layers. */
  readonly noise: number;
}

/**
 * Six archetypes of unit height (the crown top is at y = 1; the trunk starts a little below 0 so it sinks into the ground).
 * Crowns are round and organic, like a tree emoji: 3 to 5 overlapping spheres, not cones. Four broadleaf shapes
 * (aspen, birch, maple, wide oak) and two conifers drawn as layered irregular blobs.
 */
export const ARCHETYPES: readonly ArchetypeSpec[] = [
  {
    id: 0,
    name: 'aspen',
    kind: 'broadleaf',
    noise: 0.1,
    lobes: [
      { c: [0, 0.34, 0], r: [0.15, 0.17, 0.15] },
      { c: [0.04, 0.55, 0.02], r: [0.16, 0.2, 0.16] },
      { c: [-0.03, 0.76, -0.02], r: [0.14, 0.2, 0.14] },
      { c: [0, 0.88, 0], r: [0.1, 0.12, 0.1] },
    ],
  },
  {
    id: 1,
    name: 'birch',
    kind: 'broadleaf',
    noise: 0.1,
    lobes: [
      { c: [0, 0.48, 0], r: [0.27, 0.27, 0.27] },
      { c: [0.14, 0.6, 0.06], r: [0.18, 0.2, 0.18] },
      { c: [-0.12, 0.66, -0.08], r: [0.18, 0.2, 0.18] },
      { c: [0, 0.8, 0], r: [0.16, 0.19, 0.16] },
    ],
  },
  {
    id: 2,
    name: 'maple',
    kind: 'broadleaf',
    noise: 0.12,
    lobes: [
      { c: [0, 0.48, 0], r: [0.34, 0.3, 0.34] },
      { c: [0.22, 0.44, 0.1], r: [0.22, 0.22, 0.22] },
      { c: [-0.22, 0.47, -0.1], r: [0.22, 0.22, 0.22] },
      { c: [0.05, 0.72, -0.12], r: [0.24, 0.25, 0.24] },
      { c: [-0.08, 0.76, 0.12], r: [0.2, 0.22, 0.2] },
    ],
  },
  {
    id: 3,
    name: 'oak',
    kind: 'broadleaf',
    noise: 0.12,
    lobes: [
      { c: [0, 0.54, 0], r: [0.42, 0.44, 0.42] },
      { c: [0.3, 0.42, 0.12], r: [0.26, 0.24, 0.26] },
      { c: [-0.28, 0.45, -0.1], r: [0.26, 0.24, 0.26] },
    ],
  },
  {
    id: 4,
    name: 'spruce',
    kind: 'conifer',
    noise: 0.2,
    lobes: [
      { c: [0, 0.2, 0], r: [0.3, 0.14, 0.3] },
      { c: [0.02, 0.42, -0.02], r: [0.24, 0.14, 0.24] },
      { c: [-0.01, 0.62, 0.02], r: [0.17, 0.13, 0.17] },
      { c: [0, 0.84, 0], r: [0.1, 0.16, 0.1] },
    ],
  },
  {
    id: 5,
    name: 'fir',
    kind: 'conifer',
    noise: 0.2,
    lobes: [
      { c: [0, 0.16, 0], r: [0.36, 0.12, 0.36] },
      { c: [0, 0.33, 0], r: [0.31, 0.12, 0.31] },
      { c: [0.02, 0.5, 0.02], r: [0.25, 0.12, 0.25] },
      { c: [0, 0.67, 0], r: [0.18, 0.12, 0.18] },
      { c: [0, 0.85, 0], r: [0.09, 0.15, 0.09] },
    ],
  },
];

/** Hard cap on triangles per archetype after noise (the issue says under 120). */
export const ARCHETYPE_MAX_TRIANGLES = 119;

/** Deterministic 32-bit PRNG, the same one the ingest uses. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Noise in -1..1 that depends only on the (rounded) unit-sphere position, so shared vertices move together and no seam opens. */
function vertexNoise(x: number, y: number, z: number, seed: number): number {
  const h =
    Math.imul(Math.round(x * 1000), 73856093) ^
    Math.imul(Math.round(y * 1000), 19349663) ^
    Math.imul(Math.round(z * 1000), 83492791) ^
    Math.imul(seed + 1, 0x9e3779b1);
  return mulberry32(h >>> 0)() * 2 - 1;
}

function lobeGeometry(spec: ArchetypeSpec, lobe: Lobe, index: number): BufferGeometry {
  const sphere = new IcosahedronGeometry(1, 0);
  const position = sphere.getAttribute('position') as BufferAttribute;
  const count = position.count;
  const colors = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const seed = spec.id * 16 + index;
  // A per-lobe tone step and a height ramp give the crown light and dark patches without textures.
  const tone = 0.9 + 0.1 * (mulberry32(seed * 7919 + 13)() * 2 - 1);
  for (let i = 0; i < count; i += 1) {
    const ux = position.getX(i);
    const uy = position.getY(i);
    const uz = position.getZ(i);
    const k = 1 + spec.noise * vertexNoise(ux, uy, uz, seed);
    const x = lobe.c[0] + ux * k * lobe.r[0];
    const y = lobe.c[1] + uy * k * lobe.r[1];
    const z = lobe.c[2] + uz * k * lobe.r[2];
    position.setXYZ(i, x, y, z);
    // Ellipsoid surface normal at the displaced point, so the 20-face lobe shades round instead of faceted.
    const nx = (x - lobe.c[0]) / (lobe.r[0] * lobe.r[0]);
    const ny = (y - lobe.c[1]) / (lobe.r[1] * lobe.r[1]);
    const nz = (z - lobe.c[2]) / (lobe.r[2] * lobe.r[2]);
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = nx / len;
    normals[i * 3 + 1] = ny / len;
    normals[i * 3 + 2] = nz / len;
    const shade = Math.min(Math.max((0.62 + 0.38 * y) * tone, 0), 1);
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  sphere.deleteAttribute('uv');
  sphere.setAttribute('normal', new BufferAttribute(normals, 3));
  sphere.setAttribute('color', new BufferAttribute(colors, 3));
  return sphere;
}

function trunkGeometry(): BufferGeometry {
  // Four sides, open ended: 8 triangles. It runs from just below the ground to the first lobes.
  const trunk = new CylinderGeometry(0.018, 0.03, 0.34, 4, 1, true).toNonIndexed();
  trunk.translate(0, 0.13, 0);
  trunk.deleteAttribute('uv');
  const count = trunk.getAttribute('position').count;
  const colors = new Float32Array(count * 3).fill(0.4);
  trunk.setAttribute('color', new BufferAttribute(colors, 3));
  return trunk;
}

/**
 * One archetype as a single non-indexed geometry (position, smooth ellipsoid normal, colour): its lobes with seeded vertex noise, plus a four-sided trunk.
 * Vertex colour is a neutral light-to-dark ramp; the per-instance colour from the photo tints it.
 */
export function buildArchetype(id: number): BufferGeometry {
  const spec = ARCHETYPES[id];
  if (spec === undefined) throw new Error(`no tree archetype ${id}`);
  const parts = [trunkGeometry(), ...spec.lobes.map((lobe, i) => lobeGeometry(spec, lobe, i))];
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Triangles in a non-indexed geometry. */
export function triangleCount(geometry: BufferGeometry): number {
  return geometry.getAttribute('position').count / 3;
}

/** All six archetype geometries, by id. */
export function buildAllArchetypes(): BufferGeometry[] {
  return ARCHETYPES.map((spec) => buildArchetype(spec.id));
}

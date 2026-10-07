import {
  BufferAttribute,
  DataTexture,
  MeshStandardMaterial,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import type { Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { createMeshSurface } from '../../src/scene/heightfield';
import {
  buildTerrainGeometry,
  createTerrainMesh,
  setTerrainImagery,
} from '../../src/scene/terrain';
import { makeFixtureField } from '../fixtures/make-field';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

/**
 * A 2x2 checker in IMAGE order (row 0 is the top row), the order a decoded jpg has.
 * Top-left (the north-west quadrant once draped) is red, top-right green, bottom-left blue, bottom-right white.
 */
function checker(): DataTexture {
  const px = [...RED, 255, ...GREEN, 255, ...BLUE, 255, ...WHITE, 255];
  const texture = new DataTexture(new Uint8Array(px), 2, 2, RGBAFormat, UnsignedByteType);
  texture.flipY = true; // the TextureLoader default: image row 0 is placed at v = 1
  texture.needsUpdate = true;
  return texture;
}

/**
 * The colour the GPU would sample at (u, v) from an image-ordered texture with flipY = true:
 * v = 1 is the top row, u = 0 the left column. Nearest sampling, texel centres.
 */
function sampleAt(texture: Texture, u: number, v: number): number[] {
  const { data, width, height } = texture.image as {
    data: Uint8Array;
    width: number;
    height: number;
  };
  const col = Math.min(Math.floor(u * width), width - 1);
  const row = Math.min(Math.floor((1 - v) * height), height - 1);
  const i = (row * width + col) * 4;
  return [data[i] as number, data[i + 1] as number, data[i + 2] as number];
}

describe('imagery orientation', () => {
  const geometry = buildTerrainGeometry(createMeshSurface(makeFixtureField()));
  const position = geometry.getAttribute('position') as BufferAttribute;
  const uv = geometry.getAttribute('uv') as BufferAttribute;

  /** The vertex nearest a world corner: east = max or min x, north = min z (north is -z). */
  function cornerVertex(east: 'max' | 'min', north: boolean): number {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      const score =
        (east === 'max' ? position.getX(i) : -position.getX(i)) +
        (north ? -position.getZ(i) : position.getZ(i));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  it('puts the north-west corner at UV (0, 1) and the other corners at the matching UVs', () => {
    const nw = cornerVertex('min', true);
    const ne = cornerVertex('max', true);
    const sw = cornerVertex('min', false);
    const se = cornerVertex('max', false);
    expect([uv.getX(nw), uv.getY(nw)]).toEqual([0, 1]);
    expect([uv.getX(ne), uv.getY(ne)]).toEqual([1, 1]);
    expect([uv.getX(sw), uv.getY(sw)]).toEqual([0, 0]);
    expect([uv.getX(se), uv.getY(se)]).toEqual([1, 0]);
  });

  it('lands the red top-left texel of the checker on the north-west corner, and the others on theirs', () => {
    const texture = checker();
    const at = (east: 'max' | 'min', north: boolean) => {
      const i = cornerVertex(east, north);
      return sampleAt(texture, uv.getX(i), uv.getY(i));
    };
    expect(at('min', true)).toEqual(RED);
    expect(at('max', true)).toEqual(GREEN);
    expect(at('min', false)).toEqual(BLUE);
    expect(at('max', false)).toEqual(WHITE);
  });

  it('would catch a flip (instrument check): reading v as a top-down row puts the NW corner in the bottom row', () => {
    const i = cornerVertex('min', true);
    expect(Math.floor(uv.getY(i) * 2 - 1e-9)).toBe(1);
  });
});

describe('setTerrainImagery', () => {
  it('shows the map without vertex colours, and restores slope shading with null', () => {
    const mesh = createTerrainMesh(createMeshSurface(makeFixtureField()));
    const material = mesh.material as MeshStandardMaterial;
    expect(material.map).toBeNull();
    expect(material.vertexColors).toBe(true);
    const texture = checker();
    const versionBefore = material.version;
    setTerrainImagery(mesh, texture);
    expect(material.map).toBe(texture);
    expect(material.vertexColors).toBe(false);
    expect(material.version).toBeGreaterThan(versionBefore);
    setTerrainImagery(mesh, null);
    expect(material.map).toBeNull();
    expect(material.vertexColors).toBe(true);
    expect(mesh.geometry.getAttribute('color')).toBeDefined();
  });

  it('createTerrainMesh with a texture starts in imagery mode', () => {
    const texture = checker();
    const mesh = createTerrainMesh(createMeshSurface(makeFixtureField()), texture);
    expect((mesh.material as MeshStandardMaterial).map).toBe(texture);
  });
});

import {
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { describe, expect, it } from 'vitest';
import { applyRadialFade } from '../../src/scene/fade';
import {
  INSET_FEATHER_M,
  applyInsetPatch,
  buildInsetGeometry,
  createInsetPatch,
} from '../../src/scene/inset';
import { SHARPEN_AMOUNT } from '../../src/scene/terrain';

function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\n#include <map_fragment>\n#include <opaque_fragment>\n}',
  } as unknown as WebGLProgramParametersWithUniforms;
}

/** A 100 m square terrain, 10 x 10 cells, centred on the origin: east -50..50, north -50..50. */
function terrainMesh(): Mesh {
  const geometry = new PlaneGeometry(100, 100, 10, 10);
  geometry.rotateX(-Math.PI / 2);
  return new Mesh(geometry, new MeshStandardMaterial());
}

const RECT = { minEast: -20, minNorth: -10, maxEast: 20, maxNorth: 30 };

describe('buildInsetGeometry', () => {
  it('keeps only triangles touching the rect and shares the terrain attribute buffers', () => {
    const terrain = terrainMesh();
    const patch = buildInsetGeometry(terrain.geometry, RECT);
    expect(patch.index!.count).toBeGreaterThan(0);
    expect(patch.index!.count).toBeLessThan(terrain.geometry.index!.count);
    expect(patch.getAttribute('position')).toBe(terrain.geometry.getAttribute('position'));
    expect(patch.getAttribute('normal')).toBe(terrain.geometry.getAttribute('normal'));
    const position = patch.getAttribute('position');
    for (let i = 0; i < patch.index!.count; i += 3) {
      const east = [0, 1, 2].map((k) => position.getX(patch.index!.getX(i + k)));
      const north = [0, 1, 2].map((k) => -position.getZ(patch.index!.getX(i + k)));
      expect(Math.max(...east)).toBeGreaterThanOrEqual(RECT.minEast);
      expect(Math.min(...east)).toBeLessThanOrEqual(RECT.maxEast);
      expect(Math.max(...north)).toBeGreaterThanOrEqual(RECT.minNorth);
      expect(Math.min(...north)).toBeLessThanOrEqual(RECT.maxNorth);
    }
  });

  it('covers every cell inside the rect', () => {
    const terrain = terrainMesh();
    const patch = buildInsetGeometry(terrain.geometry, RECT);
    // 10 m cells: the rect spans 40 x 40 m, so at least 4 x 4 cells (2 triangles each) are inside.
    expect(patch.index!.count / 3).toBeGreaterThanOrEqual(4 * 4 * 2);
  });

  it('throws when the rect misses the terrain', () => {
    const terrain = terrainMesh();
    expect(() =>
      buildInsetGeometry(terrain.geometry, {
        minEast: 500,
        minNorth: 500,
        maxEast: 600,
        maxNorth: 600,
      }),
    ).toThrow(/does not touch/);
  });
});

describe('applyInsetPatch', () => {
  it('samples the inset by plan position with the same two fetches and unsharp mask as the terrain, and feathers alpha', () => {
    const material = new MeshStandardMaterial();
    applyRadialFade(material, { centre: { east: 0, north: 0 } });
    const uniforms = applyInsetPatch(material, RECT);
    const shader = fakeShader();
    material.onBeforeCompile(shader, null as never);
    const fragment = shader.fragmentShader;
    expect(fragment).not.toContain('#include <map_fragment>');
    expect(fragment).toContain('vec2(vInsetPos.x, -vInsetPos.y)');
    expect(fragment).toContain('texture2D(map, insetUv)');
    expect(fragment).toContain('texture2D(map, insetUv, 1.0)');
    expect(fragment.split('texture2D(').length - 1).toBe(2);
    expect(fragment).toContain(`${SHARPEN_AMOUNT.toFixed(2)} * (s0.rgb - blur)`);
    expect(fragment).toContain('smoothstep(0.0, uInsetFeather');
    expect(fragment).toContain('gl_FragColor.a *=');
    expect(shader.uniforms['uInsetRect']).toBe(uniforms.uInsetRect);
    expect(shader.uniforms['uInsetFeather']).toBe(uniforms.uInsetFeather);
    expect(uniforms.uInsetRect.value.toArray()).toEqual([-20, -10, 20, 30]);
    expect(uniforms.uInsetFeather.value).toBe(INSET_FEATHER_M);
  });

  it('chains the program cache key', () => {
    const material = new MeshStandardMaterial();
    applyRadialFade(material, { centre: { east: 0, north: 0 } });
    applyInsetPatch(material, RECT);
    expect(material.customProgramCacheKey()).toContain('radial-fade');
    expect(material.customProgramCacheKey()).toContain('inset-patch');
  });
});

describe('createInsetPatch', () => {
  it('builds a blended, depth-read-only mesh drawn after the terrain, with its own fade at the terrain fade centre', () => {
    const terrain = terrainMesh();
    const terrainFade = applyRadialFade(terrain.material as MeshStandardMaterial, {
      centre: { east: 12, north: 34 },
      innerM: 100,
      outerM: 200,
    });
    const texture = new Texture();
    const patch = createInsetPatch(terrain, texture, RECT, terrainFade);
    expect(patch.material.map).toBe(texture);
    expect(patch.material.transparent).toBe(true);
    expect(patch.material.depthWrite).toBe(false);
    expect(patch.material.polygonOffset).toBe(true);
    expect(patch.mesh.renderOrder).toBe(terrain.renderOrder + 1);
    expect(patch.fade.fadeCentre.value).toEqual([12, -34]);
    expect(patch.fade.fadeInner.value).toBe(100);
    expect(patch.fade.fadeOuter.value).toBe(200);
    expect(patch.fade).not.toBe(terrainFade);
    const hits: unknown[] = [];
    patch.mesh.raycast({} as never, hits as never);
    expect(hits).toEqual([]);
  });
});

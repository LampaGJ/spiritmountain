import { MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';
import { applyRadialFade } from '../../src/scene/fade';
import {
  DETAIL_AMOUNT,
  DETAIL_FADE_M,
  DETAIL_METRES,
  SHARPEN_AMOUNT,
  applyImagerySharpen,
} from '../../src/scene/terrain';

function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\n#include <map_fragment>\n#include <opaque_fragment>\n}',
  } as unknown as WebGLProgramParametersWithUniforms;
}

describe('applyImagerySharpen', () => {
  it('pins the issue constants', () => {
    expect(SHARPEN_AMOUNT).toBe(0.6);
    expect(DETAIL_METRES).toBe(2.0);
    expect(DETAIL_AMOUNT).toBe(0.08);
    expect(DETAIL_FADE_M).toBe(1500);
  });

  it('replaces map_fragment with an unsharp mask and a faded detail term, keeping the fade patch', () => {
    const material = new MeshStandardMaterial();
    applyRadialFade(material, { centre: { east: 0, north: 0 } });
    applyImagerySharpen(material);
    const shader = fakeShader();
    material.onBeforeCompile(shader, null as never);
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect(shader.fragmentShader).toContain('texture2D(map, vMapUv, 1.0)');
    expect(shader.fragmentShader).toContain('clamp(');
    expect(shader.fragmentShader).toContain('cameraPosition');
    expect(shader.fragmentShader).toContain('gl_FragColor.a *=');
    expect(shader.fragmentShader).toContain('vSharpenPos');
  });

  it('chains the program cache key and is idempotent', () => {
    const material = new MeshStandardMaterial();
    applyRadialFade(material, { centre: { east: 0, north: 0 } });
    applyImagerySharpen(material);
    const key = material.customProgramCacheKey();
    expect(key).toContain('radial-fade');
    expect(key).toContain('imagery-sharpen');
    applyImagerySharpen(material);
    expect(material.customProgramCacheKey()).toBe(key);
  });
});

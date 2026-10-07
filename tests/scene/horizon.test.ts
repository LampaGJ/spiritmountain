import {
  MeshStandardMaterial,
  Texture,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { describe, expect, it } from 'vitest';
import { applyRadialFade } from '../../src/scene/fade';
import {
  AERIAL_SCALE_M,
  CAPPED_NEAR_FRACTION,
  HORIZON_NEAR_FRACTION,
  applyHorizonBlend,
  createHorizonUniforms,
  equirectUv,
  horizonDistanceM,
  setHorizonSkyTexture,
  updateHorizon,
} from '../../src/scene/horizon';

function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\n#include <opaque_fragment>\n#include <tonemapping_fragment>\n}',
  } as unknown as WebGLProgramParametersWithUniforms;
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('horizonDistanceM', () => {
  it('matches sqrt(2 R h) at eye level and from a drone', () => {
    expect(Math.abs(horizonDistanceM(2) / 5048 - 1)).toBeLessThan(0.01);
    expect(Math.abs(horizonDistanceM(200) / 50479 - 1)).toBeLessThan(0.01);
  });
  it('clamps to 1 km at and below ground, and for non-finite heights', () => {
    expect(horizonDistanceM(0)).toBe(1000);
    expect(horizonDistanceM(-5)).toBe(1000);
    expect(horizonDistanceM(Number.NaN)).toBe(1000);
    expect(horizonDistanceM(0.05)).toBe(1000);
  });
});

describe('equirectUv', () => {
  it('follows three common.glsl.js equirectUv at elevation 0', () => {
    expect(equirectUv(1, 0)).toBeCloseTo(0.5, 12);
    expect(equirectUv(0, 1)).toBeCloseTo(0.75, 12);
    expect(equirectUv(0, -1)).toBeCloseTo(0.25, 12);
    expect(equirectUv(-1, 0)).toBeCloseTo(1, 12);
  });
});

describe('applyHorizonBlend', () => {
  it('inserts once before the tonemapping chunk and declares uniforms once when composed with the fade', () => {
    const material = new MeshStandardMaterial();
    applyRadialFade(material, { centre: { east: 0, north: 0 } });
    const shared = createHorizonUniforms(0x9db4c8);
    applyHorizonBlend(material, shared);
    applyHorizonBlend(material, shared);
    const shader = fakeShader();
    material.onBeforeCompile(shader, null as never);
    const frag = shader.fragmentShader;
    expect(count(frag, 'uniform sampler2D uSkyMap;')).toBe(1);
    expect(count(frag, 'uniform float uHorizonDist;')).toBe(1);
    expect(count(frag, 'varying vec2 vFadeXZ;')).toBe(1);
    expect(count(frag, 'varying vec3 vHorizonPos;')).toBe(1);
    expect(count(frag, 'smoothstep(uHorizonNear')).toBe(1);
    expect(frag).toContain(`exp(-horizonDist / ${AERIAL_SCALE_M.toFixed(1)})`);
    expect(frag).toContain('mix(gl_FragColor.rgb, behindSky, curvature)');
    expect(frag.indexOf('smoothstep(uHorizonNear')).toBeLessThan(
      frag.indexOf('#include <tonemapping_fragment>'),
    );
    expect(frag).toContain('gl_FragColor.a *= 1.0 - smoothstep(fadeInner');
    expect(frag).not.toMatch(/gl_FragColor\.a[^;]*horizon/i);
    expect(shader.uniforms['uSkyMap']).toBe(shared.uSkyMap);
    expect(shader.uniforms['fadeInner']).toBeDefined();
    expect(material.customProgramCacheKey()).toBe('radial-fade+horizon');
  });

  it('adds its own world-position varying', () => {
    const material = new MeshStandardMaterial();
    applyHorizonBlend(material, createHorizonUniforms(0x9db4c8));
    const shader = fakeShader();
    material.onBeforeCompile(shader, null as never);
    expect(count(shader.vertexShader, 'varying vec3 vHorizonPos;')).toBe(1);
    expect(count(shader.fragmentShader, 'varying vec3 vHorizonPos;')).toBe(1);
  });

  it('shares one uniforms object across materials', () => {
    const shared = createHorizonUniforms(0x9db4c8);
    const a = new MeshStandardMaterial();
    const b = new MeshStandardMaterial();
    applyHorizonBlend(a, shared);
    applyHorizonBlend(b, shared);
    const sa = fakeShader();
    const sb = fakeShader();
    a.onBeforeCompile(sa, null as never);
    b.onBeforeCompile(sb, null as never);
    expect(sa.uniforms['uCameraPos']).toBe(sb.uniforms['uCameraPos']);
    expect(sa.uniforms['uHorizonDist']).toBe(shared.uHorizonDist);
  });
});

describe('horizon uniform helpers', () => {
  it('updateHorizon sets distance and the HORIZON_NEAR_FRACTION near fraction; the sky toggles uHasSky', () => {
    const shared = createHorizonUniforms(0x9db4c8);
    updateHorizon(shared, new Vector3(1, 2, 3), 200);
    expect(shared.uHorizonDist.value).toBeCloseTo(50479, -2);
    expect(shared.uHorizonNear.value).toBeCloseTo(
      HORIZON_NEAR_FRACTION * shared.uHorizonDist.value,
      6,
    );
    expect(shared.uCameraPos.value.toArray()).toEqual([1, 2, 3]);
    const texture = new Texture();
    setHorizonSkyTexture(shared, texture);
    expect([shared.uSkyMap.value, shared.uHasSky.value]).toEqual([texture, 1]);
    setHorizonSkyTexture(shared, null);
    expect(shared.uHasSky.value).toBe(0);
  });
});

describe('updateHorizon cap', () => {
  it('caps the distance at maxDistM so the blend completes inside the far plane', () => {
    const shared = createHorizonUniforms(0x9db4c8);
    updateHorizon(shared, new Vector3(), 5000, 40_000);
    expect(shared.uHorizonDist.value).toBe(40_000);
    expect(shared.uHorizonNear.value).toBeCloseTo(CAPPED_NEAR_FRACTION * 40_000, 6);
  });
});

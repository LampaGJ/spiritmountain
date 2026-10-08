import { MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';
import {
  SKY_BAKE_HEIGHT,
  SKY_BAKE_WIDTH,
  SKY_MIE_COEFFICIENT,
  SKY_RAYLEIGH,
  SKY_SUN_ELEVATION_DEG,
  SKY_TURBIDITY,
  bakeSkyTexture,
  createProceduralSkyMesh,
  horizonColor,
  skyRadiance,
  sunDirection,
} from '../../src/scene/procedural-sky';
import { applyHorizonBlend, createHorizonUniforms } from '../../src/scene/horizon';

const lum = (c: { r: number; g: number; b: number }): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const dirAt = (elevDeg: number, azDeg: number): [number, number, number] => {
  const e = (elevDeg * Math.PI) / 180;
  const a = (azDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
};

describe('procedural sky', () => {
  it('uses the issue parameters and puts the sun in the south-west at 42 degrees', () => {
    const sky = createProceduralSkyMesh();
    const u = (sky.material as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
    expect(u['turbidity']?.value).toBe(SKY_TURBIDITY);
    expect(SKY_TURBIDITY).toBe(1.6);
    expect(SKY_RAYLEIGH).toBe(1.0);
    expect(SKY_MIE_COEFFICIENT).toBe(0.003);
    expect(u['mieDirectionalG']?.value).toBe(0.8);
    const [x, y, z] = sunDirection();
    expect(Math.asin(y) * (180 / Math.PI)).toBeCloseTo(SKY_SUN_ELEVATION_DEG, 6);
    expect(x).toBeLessThan(0);
    expect(z).toBeGreaterThan(0);
  });

  it('is a clean blue gradient at the horizon: blue-dominant, unclipped, and only gets lighter toward the horizon', () => {
    const h = horizonColor(0);
    expect(h.b).toBeGreaterThan(h.g);
    expect(h.g).toBeGreaterThan(h.r);
    expect((h.b - h.r) / h.b).toBeGreaterThan(0.15);
    expect(Math.max(h.r, h.g, h.b)).toBeLessThan(0.95);
    const lums = [90, 60, 30, 10, 3, 0].map((e) => lum(horizonColor(e)));
    for (let i = 1; i < lums.length; i++) expect(lums[i]).toBeGreaterThan(lums[i - 1] ?? 0);
  });

  it('is deterministic and finite', () => {
    expect(skyRadiance(dirAt(3, 100))).toEqual(skyRadiance(dirAt(3, 100)));
    for (const e of [-90, -10, 0, 1, 45, 90])
      for (const rgb of skyRadiance(dirAt(e, 40))) expect(Number.isFinite(rgb)).toBe(true);
  });

  it('bakes a half-float equirect table the horizon blend can sample, and seeds the aerial tint uniform', () => {
    const texture = bakeSkyTexture();
    expect([texture.image.width, texture.image.height]).toEqual([SKY_BAKE_WIDTH, SKY_BAKE_HEIGHT]);
    expect((texture.image.data as Uint16Array).length).toBe(SKY_BAKE_WIDTH * SKY_BAKE_HEIGHT * 4);
    expect(createHorizonUniforms(0x9db4c8).uAerialTint.value.getHex()).toBe(0xa9bccd);
  });

  it('feeds the aerial tint to the ground blend through a uniform, not a constant', () => {
    const material = new MeshStandardMaterial();
    applyHorizonBlend(material, createHorizonUniforms(0x9db4c8));
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <tonemapping_fragment>',
    } as unknown as WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, null as never);
    expect(shader.fragmentShader).toContain('uniform vec3 uAerialTint;');
    expect(shader.fragmentShader).toContain('uAerialTint, aerial)');
    expect(shader.uniforms['uAerialTint']).toBeDefined();
  });
});

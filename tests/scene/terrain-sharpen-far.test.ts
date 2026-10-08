import { MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';
import { applyRadialFade } from '../../src/scene/fade';
import {
  SHARPEN_AMOUNT,
  SHARPEN_FAR_FRACTION,
  SHARPEN_FAR_M,
  applyImagerySharpen,
} from '../../src/scene/terrain';

describe('sharpen falloff with distance from the resort', () => {
  it('pins the falloff constants: full at the fade centre, half at about the frame edge', () => {
    expect(SHARPEN_FAR_M).toBe(3500);
    expect(SHARPEN_FAR_FRACTION).toBe(0.5);
  });

  it('scales the unsharp amount by a smoothstep on the distance to the fade centre', () => {
    const material = new MeshStandardMaterial();
    applyRadialFade(material, { centre: { east: 0, north: 0 } });
    applyImagerySharpen(material);
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n}',
    } as unknown as WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, null as never);
    expect(shader.fragmentShader).toContain(
      `float sharpK = ${SHARPEN_AMOUNT.toFixed(2)} * mix(1.0, ${SHARPEN_FAR_FRACTION.toFixed(2)}, smoothstep(0.0, ${SHARPEN_FAR_M.toFixed(1)}, distance(vSharpenPos, fadeCentre)))`,
    );
    expect(shader.fragmentShader).toContain('s0.rgb + sharpK * (s0.rgb - blur)');
  });
});

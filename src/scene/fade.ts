import type { IUniform, Material, WebGLProgramParametersWithUniforms } from 'three';
import { FADE_INNER_M, FADE_OUTER_M } from '../../scripts/ingest/context-tiles';

export interface RadialFadeOptions {
  /** Fade centre in local metres (east, north), the resort focus box centre. */
  readonly centre: { readonly east: number; readonly north: number };
  /** Alpha is 1 at and inside this distance in metres. Defaults to FADE_INNER_M. */
  readonly innerM?: number;
  /** Alpha is 0 at and beyond this distance in metres. Defaults to FADE_OUTER_M. */
  readonly outerM?: number;
}

export interface RadialFadeUniforms {
  /** Fade centre on the scene ground plane: (x east, z = -north). */
  readonly fadeCentre: IUniform<[number, number]>;
  readonly fadeInner: IUniform<number>;
  readonly fadeOuter: IUniform<number>;
}

/** Moves the fade centre (local metres east and north) on a material patched by applyRadialFade. */
export function setFadeCentre(
  uniforms: RadialFadeUniforms,
  centre: { readonly east: number; readonly north: number },
): void {
  uniforms.fadeCentre.value = [centre.east, -centre.north];
}

/**
 * Patches a MeshStandardMaterial so its alpha falls off with horizontal distance from a centre:
 * 1 inside innerM, 0 at outerM and beyond, smoothstep between (the same curve as fadeAlpha in
 * scripts/ingest/context-tiles.ts). The vertex shader passes world x and z; the fragment shader
 * multiplies gl_FragColor.a. The material becomes transparent with depthWrite on, so the terrain
 * still occludes itself and the lines drawn over it.
 *
 * Returns the uniform objects so a caller can move the centre later.
 */
export function applyRadialFade(
  material: Material,
  options: RadialFadeOptions,
): RadialFadeUniforms {
  const uniforms: RadialFadeUniforms = {
    fadeCentre: { value: [options.centre.east, -options.centre.north] },
    fadeInner: { value: options.innerM ?? FADE_INNER_M },
    fadeOuter: { value: options.outerM ?? FADE_OUTER_M },
  };
  material.transparent = true;
  material.depthWrite = true;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms['fadeCentre'] = uniforms.fadeCentre;
    shader.uniforms['fadeInner'] = uniforms.fadeInner;
    shader.uniforms['fadeOuter'] = uniforms.fadeOuter;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFadeXZ;')
      .replace(
        '#include <begin_vertex>',
        // An InstancedMesh (the trees, src/scene/trees.ts:124) places each copy with instanceMatrix, applied after this chunk.
        '#include <begin_vertex>\n#ifdef USE_INSTANCING\nvFadeXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;\n#else\nvFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\n#endif',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vFadeXZ;\nuniform vec2 fadeCentre;\nuniform float fadeInner;\nuniform float fadeOuter;',
      )
      .replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(fadeInner, fadeOuter, distance(vFadeXZ, fadeCentre));',
      );
  };
  material.customProgramCacheKey = () => 'radial-fade';
  material.needsUpdate = true;
  return uniforms;
}

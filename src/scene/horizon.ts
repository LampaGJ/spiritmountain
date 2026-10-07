import { Color, Vector3, type IUniform, type Material, type Texture } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

/** Mean Earth radius in metres. */
export const EARTH_RADIUS_M = 6_371_000;
/** The horizon never comes closer than this, so a camera at ground level still sees a blend zone. */
export const MIN_HORIZON_M = 1000;
/** The blend starts at this fraction of the horizon distance. */
export const HORIZON_NEAR_FRACTION = 0.3;

/** Distance in metres to the geometric horizon from an eye heightM above the ground plane: sqrt(2 R h), at least 1 km. */
export function horizonDistanceM(heightM: number): number {
  const h = Number.isFinite(heightM) ? Math.max(heightM, 0) : 0;
  return Math.max(MIN_HORIZON_M, Math.sqrt(2 * EARTH_RADIUS_M * h));
}

/**
 * u for elevation 0 along the horizontal direction (dirX, dirZ), in three's equirect convention. Mirrors
 * equirectUv in node_modules/three/src/renderers/shaders/ShaderChunk/common.glsl.js:91-97
 * (u = atan(dir.z, dir.x) * RECIPROCAL_PI2 + 0.5); v at elevation 0 is 0.5.
 */
export function equirectUv(dirX: number, dirZ: number): number {
  return Math.atan2(dirZ, dirX) / (2 * Math.PI) + 0.5;
}

/** The uniform set shared by every patched material, so one write per frame reaches all of them. */
export interface HorizonUniforms {
  uSkyMap: IUniform<Texture | null>;
  uHasSky: IUniform<number>;
  uHorizonDist: IUniform<number>;
  uHorizonNear: IUniform<number>;
  uCameraPos: IUniform<Vector3>;
  uFallbackColor: IUniform<Color>;
}

export function createHorizonUniforms(fallbackColor: number): HorizonUniforms {
  return {
    uSkyMap: { value: null },
    uHasSky: { value: 0 },
    uHorizonDist: { value: MIN_HORIZON_M },
    uHorizonNear: { value: HORIZON_NEAR_FRACTION * MIN_HORIZON_M },
    uCameraPos: { value: new Vector3() },
    uFallbackColor: { value: new Color(fallbackColor) },
  };
}

/**
 * Sets the horizon distance and the blend start from the eye height above the ground plane in true metres.
 * maxDistM caps the distance (pass a fraction of camera.far) so the blend is complete before the far plane
 * clips the ground, which would otherwise leave a hard edge when the true horizon lies past the far plane.
 */
export function updateHorizon(
  shared: HorizonUniforms,
  cameraPos: Vector3,
  heightM: number,
  maxDistM = Number.POSITIVE_INFINITY,
): void {
  shared.uCameraPos.value.copy(cameraPos);
  const d = Math.min(horizonDistanceM(heightM), maxDistM);
  shared.uHorizonDist.value = d;
  shared.uHorizonNear.value = HORIZON_NEAR_FRACTION * d;
}

/** Points the blend at the sky panorama, or at the flat fallback colour with null. */
export function setHorizonSkyTexture(shared: HorizonUniforms, texture: Texture | null): void {
  shared.uSkyMap.value = texture;
  shared.uHasSky.value = texture ? 1 : 0;
}

const MARKER = 'horizonBlend';

/**
 * Patches a material so fragments fade into the sky colour at the horizon: the mix runs on the linear colour
 * just before the tonemapping chunk, so the HDR sample takes the same tone mapping as the background. Alpha is
 * untouched, so applyRadialFade still works. Call it AFTER applyRadialFade: it wraps whatever onBeforeCompile
 * and customProgramCacheKey the material already has, and reuses the fade patch's vFadeXZ varying when present.
 * Idempotent per material (marker in material.userData). Every patched material shares one `shared` object.
 */
export function applyHorizonBlend(material: Material, shared: HorizonUniforms): void {
  if (material.userData[MARKER]) return;
  material.userData[MARKER] = true;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(material, shader, renderer);
    for (const [name, uniform] of Object.entries(shared)) shader.uniforms[name] = uniform;
    const hasFade = shader.vertexShader.includes('vFadeXZ');
    const varying = hasFade ? 'vFadeXZ' : 'vHorizonXZ';
    if (!hasFade) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vHorizonXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvHorizonXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
        );
    }
    const declarations = [
      hasFade ? '' : 'varying vec2 vHorizonXZ;',
      'uniform sampler2D uSkyMap;',
      'uniform float uHasSky;',
      'uniform float uHorizonDist;',
      'uniform float uHorizonNear;',
      'uniform vec3 uCameraPos;',
      'uniform vec3 uFallbackColor;',
    ]
      .filter(Boolean)
      .join('\n');
    const blend = `{
  vec2 horizonOffset = ${varying} - uCameraPos.xz;
  float horizonDist = length(horizonOffset);
  vec2 horizonDir = horizonOffset / max(horizonDist, 1e-3);
  float horizonU = atan(horizonDir.y, horizonDir.x) * RECIPROCAL_PI2 + 0.5;
  vec3 horizonSky = uHasSky > 0.5 ? textureLod(uSkyMap, vec2(horizonU, 0.5), 0.0).rgb : uFallbackColor;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, horizonSky, smoothstep(uHorizonNear, uHorizonDist, horizonDist));
}`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${declarations}`)
      .replace('#include <tonemapping_fragment>', `${blend}\n#include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}+horizon`;
  material.needsUpdate = true;
}

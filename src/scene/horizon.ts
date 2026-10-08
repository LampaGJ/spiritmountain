import { Color, Vector3, type IUniform, type Material, type Texture } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

/** Mean Earth radius in metres. */
export const EARTH_RADIUS_M = 6_371_000;
/** The horizon never comes closer than this, so a camera at ground level still sees a blend zone. */
export const MIN_HORIZON_M = 1000;
/**
 * The sky blend starts at this fraction of the horizon distance. The band is narrow because it stands in for
 * Earth's curvature hiding the ground, which happens at the horizon, not over the last two thirds of the view.
 * The earlier 0.3 washed everything past a third of the distance into the sky's horizon band and read as smog.
 */
export const HORIZON_NEAR_FRACTION = 0.88;
/**
 * When the far plane caps the horizon short of the true one (high cameras), the ground ends at an artificial edge
 * on a flat, detail-free plane, so a wider band hides that edge instead of drawing a disc rim.
 */
export const CAPPED_NEAR_FRACTION = 0.75;
/**
 * Aerial perspective length scale in metres: ground colour relaxes toward the horizon sky as 1 - exp(-d / L).
 * Koschmieder with a very clear day; 60 km (was 80 km, #52) because the far field still greyed. At 5 km this tints by
 * 8 percent, at 20 km by 28 percent, so the near slopes stay saturated and only far ground picks up blue.
 */
export const AERIAL_SCALE_M = 60_000;
/**
 * The starting value of the uAerialTint uniform (sRGB blue-grey); scene.ts overwrites it with the procedural sky colour
 * just above the horizon (#52). A photo panorama's horizon band is near white, and mixing ground toward white over tens
 * of kilometres read as smog.
 */
export const AERIAL_TINT = 0xa9bccd;

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
  /** Linear colour far ground relaxes toward; scene.ts sets it to the procedural sky colour at the horizon. AERIAL_TINT until then. */
  uAerialTint: IUniform<Color>;
}

export function createHorizonUniforms(fallbackColor: number): HorizonUniforms {
  return {
    uSkyMap: { value: null },
    uHasSky: { value: 0 },
    uHorizonDist: { value: MIN_HORIZON_M },
    uHorizonNear: { value: HORIZON_NEAR_FRACTION * MIN_HORIZON_M },
    uCameraPos: { value: new Vector3() },
    uFallbackColor: { value: new Color(fallbackColor) },
    uAerialTint: { value: new Color(AERIAL_TINT) },
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
  const trueD = horizonDistanceM(heightM);
  const d = Math.min(trueD, maxDistM);
  shared.uHorizonDist.value = d;
  shared.uHorizonNear.value = (d < trueD ? CAPPED_NEAR_FRACTION : HORIZON_NEAR_FRACTION) * d;
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
 * and customProgramCacheKey the material already has; it carries its own vHorizonPos varying (world xyz).
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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHorizonPos;')
      .replace(
        '#include <begin_vertex>',
        // An InstancedMesh (the trees, src/scene/trees.ts:124) places each copy with instanceMatrix, applied after this chunk.
        '#include <begin_vertex>\n#ifdef USE_INSTANCING\nvHorizonPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#else\nvHorizonPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif',
      );
    const declarations = [
      'varying vec3 vHorizonPos;',
      'uniform sampler2D uSkyMap;',
      'uniform float uHasSky;',
      'uniform float uHorizonDist;',
      'uniform float uHorizonNear;',
      'uniform vec3 uCameraPos;',
      'uniform vec3 uFallbackColor;',
      'uniform vec3 uAerialTint;',
    ].join('\n');
    // Two sky samples. The aerial tint relaxes toward the sky AT the horizon (v = 0.5), the colour haze really
    // takes on. The curvature term blends toward the sky in the fragment's own view direction, so wherever the
    // ground ends (true horizon, or the far-plane cap seen from a high camera) it matches the background behind it
    // and leaves no ring.
    const blend = `{
  vec3 horizonOffset = vHorizonPos - uCameraPos;
  float horizonDist = length(horizonOffset.xz);
  vec2 horizonDir = horizonOffset.xz / max(horizonDist, 1e-3);
  float horizonU = atan(horizonDir.y, horizonDir.x) * RECIPROCAL_PI2 + 0.5;
  vec3 viewDir = normalize(horizonOffset);
  float horizonV = asin(clamp(viewDir.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5;
  vec3 horizonSky = uHasSky > 0.5 ? textureLod(uSkyMap, vec2(horizonU, 0.5), 0.0).rgb : uFallbackColor;
  vec3 behindSky = uHasSky > 0.5 ? textureLod(uSkyMap, vec2(horizonU, horizonV), 0.0).rgb : uFallbackColor;
  float aerial = 1.0 - exp(-horizonDist / ${AERIAL_SCALE_M.toFixed(1)});
  float curvature = smoothstep(uHorizonNear, uHorizonDist, horizonDist);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uAerialTint, aerial);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, behindSky, curvature);
}`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${declarations}`)
      .replace('#include <tonemapping_fragment>', `${blend}\n#include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}+horizon`;
  material.needsUpdate = true;
}

import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  RepeatWrapping,
  ClampToEdgeWrapping,
  type Mesh,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/** Clear-day Preetham parameters from issue #52. */
export const SKY_TURBIDITY = 1.6;
export const SKY_RAYLEIGH = 1.0;
export const SKY_MIE_COEFFICIENT = 0.003;
export const SKY_MIE_DIRECTIONAL_G = 0.8;
/** Sun elevation above the horizon in degrees. */
export const SKY_SUN_ELEVATION_DEG = 42;
/** Sun azimuth: from the south-west, the side the scene's directional light shines from (x east, z south, so west is -x and south is +z). */
export const SKY_SUN_AZIMUTH_DEG_FROM_SOUTH_TOWARD_WEST = 45;
/** Elevation, in degrees, at which the aerial-perspective tint is read. 0 degrees is a pale grey-blue that turned the far field grey-green in the capture; 8 degrees is the same gradient's blue just above the haze, so far ground reads blue, and the curvature blend still ends on the true horizon colour from the bake. */
export const AERIAL_SAMPLE_ELEVATION_DEG = 0;

/** Bake size: azimuth x elevation (-90 to +90). The horizon gradient moves fast, so elevation gets 0.7 degrees per row. */
export const SKY_BAKE_WIDTH = 64;
export const SKY_BAKE_HEIGHT = 256;

/**
 * Preetham radiance runs far past 1 (about 6 at the horizon, 1 at the zenith) and the renderer applies no tone
 * mapping, so raw output clips to white. The backdrop and the CPU bake share one hue-preserving Reinhard on
 * luminance, rgb * E / (1 + E * L), so the horizon stays a pale blue instead of clipping and zenith to horizon
 * is one smooth gradient. E was judged by eye against headless captures (2026-10-08).
 */
export const SKY_EXPOSURE = 0.25;
/**
 * Preetham's horizon is cyan-white (linear rgb about 0.73 : 0.96 : 1), so even tone-mapped it reads as a pale grey
 * band against the blue above, and far ground blended toward it greys out (#52 capture, 2026-10-08). This per-channel
 * multiplier, applied after the tone curve in both the shader and the CPU port, pulls the horizon to a clear sky blue
 * and leaves the already-blue upper sky almost unchanged. Judged by eye against headless Resort and Overview captures.
 */
export const SKY_GRADE: readonly [number, number, number] = [0.55, 0.85, 1.0];

/** Unit vector toward the sun in scene axes (x east, y up, z south). */
export function sunDirection(): [number, number, number] {
  const el = (SKY_SUN_ELEVATION_DEG * Math.PI) / 180;
  const az = (SKY_SUN_AZIMUTH_DEG_FROM_SOUTH_TOWARD_WEST * Math.PI) / 180;
  const h = Math.cos(el);
  return [-Math.sin(az) * h, Math.sin(el), Math.cos(az) * h];
}

// Constants copied from three/examples/jsm/objects/Sky.js (SkyShader vertex and fragment), so the CPU evaluation
// matches the mesh that draws the backdrop.
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

/**
 * Linear radiance (before tone mapping and colour-space output) of the Sky.js Preetham shader for a unit view
 * direction, with clouds and the sun disc off. Mirrors Sky.js; the horizon blend in horizon.ts reads it so far
 * ground fades to exactly the colour the backdrop shows.
 */
export function skyRadiance(dir: readonly [number, number, number]): [number, number, number] {
  const sun = sunDirection();
  const zenithCos = Math.min(Math.max(sun[1], -1), 1);
  const sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(zenithCos)) / STEEPNESS)));
  const mieC = 0.2 * SKY_TURBIDITY * 1e-17;
  const betaR = TOTAL_RAYLEIGH.map((v) => v * SKY_RAYLEIGH);
  const betaM = MIE_CONST.map((v) => 0.434 * mieC * v * SKY_MIE_COEFFICIENT);

  const zenithAngle = Math.acos(Math.max(0, dir[1]));
  const inverse =
    1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  const cosTheta = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const rPhase = THREE_OVER_SIXTEENPI * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g = SKY_MIE_DIRECTIONAL_G;
  const mPhase = ONE_OVER_FOURPI * ((1 - g * g) / Math.pow(1 - 2 * g * cosTheta + g * g, 1.5));
  const earthShadow = Math.min(Math.max(Math.pow(1 - sun[1], 5), 0), 1);

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const br = betaR[c] ?? 0;
    const bm = betaM[c] ?? 0;
    const fex = Math.exp(-(br * sR + bm * sM));
    const scatter = (sunE * (br * rPhase + bm * mPhase)) / (br + bm);
    let lin = Math.pow(scatter * (1 - fex), 1.5);
    lin *= 1 + (Math.pow(scatter * fex, 0.5) - 1) * earthShadow;
    const l0 = 0.1 * fex;
    out[c] = (lin + l0) * 0.04 + (c === 0 ? 0 : c === 1 ? 0.0003 : 0.00075);
  }
  const luma = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  const k = SKY_EXPOSURE / (1 + SKY_EXPOSURE * luma);
  return [out[0] * k * SKY_GRADE[0], out[1] * k * SKY_GRADE[1], out[2] * k * SKY_GRADE[2]];
}

/** Linear colour at elevationDeg, averaged over every azimuth (the sun side is warmer, so the mean is the neutral horizon). */
export function horizonColor(elevationDeg: number = AERIAL_SAMPLE_ELEVATION_DEG): Color {
  const el = (elevationDeg * Math.PI) / 180;
  const sum = [0, 0, 0];
  const n = 72;
  for (let i = 0; i < n; i++) {
    const az = ((i + 0.5) / n) * 2 * Math.PI;
    const rgb = skyRadiance([
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    ]);
    for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (rgb[c] ?? 0);
  }
  return new Color(sum[0]! / n, sum[1]! / n, sum[2]! / n);
}

/**
 * Equirectangular half-float bake of skyRadiance in three's convention (u = atan2(z, x) / 2pi + 0.5, v = elevation / pi
 * + 0.5, row 0 at the bottom), so horizon.ts samples it exactly as it sampled the HDR panorama. Linear, no colour space.
 */
export function bakeSkyTexture(): DataTexture {
  const w = SKY_BAKE_WIDTH;
  const h = SKY_BAKE_HEIGHT;
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const elev = ((y + 0.5) / h - 0.5) * Math.PI;
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const rgb = skyRadiance([
        Math.cos(elev) * Math.cos(phi),
        Math.sin(elev),
        Math.cos(elev) * Math.sin(phi),
      ]);
      const o = (y * w + x) * 4;
      data[o] = DataUtils.toHalfFloat(rgb[0]);
      data[o + 1] = DataUtils.toHalfFloat(rgb[1]);
      data[o + 2] = DataUtils.toHalfFloat(rgb[2]);
      data[o + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const texture = new DataTexture(data, w, h, RGBAFormat, HalfFloatType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** The backdrop mesh (Sky.js with the issue's parameters, no clouds, no sun disc). It draws at the far plane, so it stays outside ElevatedGroup and needs no fade. */
export function createProceduralSkyMesh(): Mesh {
  const sky = new Sky();
  const u = sky.material.uniforms;
  // Same tone curve as skyRadiance (see SKY_EXPOSURE), inserted where the shader writes its colour.
  sky.material.onBeforeCompile = (shader) => {
    // Sky.js's own `rand` shadows the one three's dithering chunk calls, so the dither is written inline: triangular
    // noise of one 8-bit level after the colour-space step, which breaks the gradient's one-level contours into grain.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      `#include <colorspace_fragment>
			float ditherA = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
			float ditherB = fract( sin( dot( gl_FragCoord.xy, vec2( 26.6513, 41.337 ) ) ) * 24634.6345 );
			gl_FragColor.rgb += ( ditherA + ditherB - 1.0 ) / 255.0;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      `float skyLuma = dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) );
			texColor *= ${SKY_EXPOSURE.toFixed(4)} / ( 1.0 + ${SKY_EXPOSURE.toFixed(4)} * skyLuma );
			texColor *= vec3( ${SKY_GRADE.map((v) => v.toFixed(4)).join(', ')} );
			gl_FragColor = vec4( texColor, 1.0 );`,
    );
  };
  u['turbidity']!.value = SKY_TURBIDITY;
  u['rayleigh']!.value = SKY_RAYLEIGH;
  u['mieCoefficient']!.value = SKY_MIE_COEFFICIENT;
  u['mieDirectionalG']!.value = SKY_MIE_DIRECTIONAL_G;
  u['cloudCoverage']!.value = 0;
  u['showSunDisc']!.value = 0;
  u['sunPosition']!.value.set(...sunDirection());
  sky.scale.setScalar(450_000);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  return sky;
}

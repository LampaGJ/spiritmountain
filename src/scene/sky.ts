import {
  Color,
  type DirectionalLight,
  type HemisphereLight,
  type Scene,
  type Texture,
} from 'three';

export const SKY_FALLBACK_COLOR = 0x9db4c8;
/** With the photo sky the sun drops to 0.6 of its flat-sky intensity and the hemisphere to a quarter (the environment map supplies the ambient term). */
export const SKY_SUN_FACTOR = 0.5;
export const SKY_HEMI_FACTOR = 0.25;
/** The HDR panorama is bright at midday; scale its image-based lighting so the photo texture is not over-exposed (judged by eye, 2026-10-06). */
export const SKY_ENVIRONMENT_INTENSITY = 0.55;

export interface SkyLights {
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
}

export interface SkyControl {
  setSky(texture: Texture): void;
  setSkyFallback(): void;
}

/** Sky photo as background and environment, with the lights trimmed; or the flat colour and the original lights. */
export function createSkyControl(scene: Scene, lights: SkyLights): SkyControl {
  const sun0 = lights.sun.intensity;
  const hemi0 = lights.hemisphere.intensity;
  return {
    setSky(texture) {
      scene.background = texture;
      scene.environment = texture;
      scene.environmentIntensity = SKY_ENVIRONMENT_INTENSITY;
      lights.sun.intensity = sun0 * SKY_SUN_FACTOR;
      lights.hemisphere.intensity = hemi0 * SKY_HEMI_FACTOR;
    },
    setSkyFallback() {
      scene.background = new Color(SKY_FALLBACK_COLOR);
      scene.environment = null;
      scene.environmentIntensity = 1;
      lights.sun.intensity = sun0;
      lights.hemisphere.intensity = hemi0;
    },
  };
}

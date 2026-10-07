import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Texture,
} from 'three';
import { describe, expect, it } from 'vitest';
import { loadSky } from '../../src/data/load-sky';
import { elevationToSceneY } from '../../src/scene/frame';
import { createGround, GROUND_SIZE_M, groundSlopeColor } from '../../src/scene/ground';
import {
  createSkyControl,
  SKY_ENVIRONMENT_INTENSITY,
  SKY_FALLBACK_COLOR,
  SKY_HEMI_FACTOR,
  SKY_SUN_FACTOR,
} from '../../src/scene/sky';

describe('createGround', () => {
  it('puts a 60 km opaque plane 0.5 m under the base elevation, in the given colour, first in draw order', () => {
    const colour = new Color(0.1545, 0.1845, 0.1331);
    const ground = createGround(colour, 183.08);
    expect(ground.position.y).toBeCloseTo(elevationToSceneY(183.08) - 0.5, 9);
    expect(ground.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    expect(ground.renderOrder).toBeLessThan(0);
    expect(ground.receiveShadow).toBe(false);
    const params = (ground.geometry as PlaneGeometry).parameters;
    expect([params.width, params.height]).toEqual([GROUND_SIZE_M, GROUND_SIZE_M]);
    const material = ground.material as MeshStandardMaterial;
    expect(material.color.equals(colour)).toBe(true);
    expect([material.roughness, material.metalness, material.transparent]).toEqual([1, 0, false]);
  });

  it('re-tints to the slope mid colour, which lies between the palette ends', () => {
    const material = (createGround(0xffffff, 0) as Mesh).material as MeshStandardMaterial;
    material.color.set(groundSlopeColor());
    expect(material.color.equals(groundSlopeColor())).toBe(true);
    expect(groundSlopeColor().g).toBeGreaterThan(0);
  });
});

describe('sky control', () => {
  const setup = () => {
    const scene = new Scene();
    scene.background = new Color(SKY_FALLBACK_COLOR);
    const sun = new DirectionalLight(0xffffff, 2.2);
    const hemisphere = new HemisphereLight(0xffffff, 0x000000, 1.2);
    return { scene, sun, hemisphere, control: createSkyControl(scene, { sun, hemisphere }) };
  };

  it('sets background and environment to the same texture and trims the lights', () => {
    const { scene, sun, hemisphere, control } = setup();
    const texture = new Texture();
    control.setSky(texture);
    expect(scene.background).toBe(texture);
    expect(scene.environment).toBe(texture);
    expect(sun.intensity).toBeCloseTo(2.2 * SKY_SUN_FACTOR, 9);
    expect(hemisphere.intensity).toBeCloseTo(1.2 * SKY_HEMI_FACTOR, 9);
    expect(scene.environmentIntensity).toBe(SKY_ENVIRONMENT_INTENSITY);
  });

  it('restores the flat colour, no environment and the original intensities', () => {
    const { scene, sun, hemisphere, control } = setup();
    control.setSky(new Texture());
    control.setSkyFallback();
    expect((scene.background as Color).getHex()).toBe(SKY_FALLBACK_COLOR);
    expect(scene.environment).toBeNull();
    expect([sun.intensity, hemisphere.intensity]).toEqual([2.2, 1.2]);
  });
});

describe('loadSky', () => {
  it('maps the texture as equirectangular reflection, or resolves to { error }', async () => {
    const ok = await loadSky('/sky.hdr', () => Promise.resolve(new Texture()));
    expect((ok as Texture).mapping).toBe(303);
    const bad = await loadSky('/sky.hdr', () => Promise.reject(new Error('404')));
    expect(bad).toEqual({ error: 'could not load /sky.hdr: 404' });
  });
});

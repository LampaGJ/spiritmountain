import { EquirectangularReflectionMapping, type Texture } from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import skyUrl from '../../data/raw/sky.hdr?url';

export type SkyResult = Texture | { readonly error: string };

/**
 * @displayName Sky loader
 * @strategicPurpose Consumer side of the pinned sky panorama (data/raw/sky.hdr, CC0): turns it into the scene background and image-based light, and turns any failure into a visible reason so the flat sky colour stays.
 * @tacticalObjective Loads the Radiance HDR through three's RGBELoader, sets the equirectangular reflection mapping, and resolves to the texture or to { error }. Never rejects.
 */
export async function loadSky(
  url: string = skyUrl,
  loadTexture: (u: string) => Promise<Texture> = (u) => new RGBELoader().loadAsync(u),
): Promise<SkyResult> {
  try {
    const texture = await loadTexture(url);
    texture.mapping = EquirectangularReflectionMapping;
    return texture;
  } catch (error) {
    return { error: `could not load ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

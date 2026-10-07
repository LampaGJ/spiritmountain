import { SRGBColorSpace, TextureLoader, type Texture } from 'three';

/** Either the texture, or null with the reason the caller shows. The loader never throws. */
export type ImageryResult = { texture: Texture; reason?: undefined } | { texture: null; reason: string };

export interface LoadImageryOptions {
  readonly url: string;
  /** The renderer's capabilities: anisotropy and the texture size limit come from here. */
  readonly capabilities: { getMaxAnisotropy(): number; maxTextureSize: number };
  /** The image size the manifest pins. A texture larger than the GPU limit would silently downscale or fail. */
  readonly expectedWidth?: number;
  /** Injected so tests run in node without an image decoder. Defaults to three's TextureLoader. */
  readonly loadTexture?: (url: string) => Promise<Texture>;
}

/**
 * @displayName Imagery loader
 * @strategicPurpose Consumer side of the imagery pin: turns data/raw/naip.jpg into a terrain texture, and turns any failure into a visible reason instead of a broken or blank terrain.
 * @tacticalObjective Loads the jpg through three's TextureLoader, sets sRGB colour space and the renderer's maximum anisotropy, and resolves to null plus a reason on a load error or a texture wider than the GPU limit.
 *
 * Orientation: flipY stays true (the loader default), so the image's top row is v = 1, which is north on the terrain mesh. See src/scene/terrain.ts.
 */
export async function loadImagery(options: LoadImageryOptions): Promise<ImageryResult> {
  const { url, capabilities, expectedWidth } = options;
  if (expectedWidth !== undefined && expectedWidth > capabilities.maxTextureSize) {
    return {
      texture: null,
      reason: `image is ${expectedWidth} px wide but this GPU allows ${capabilities.maxTextureSize}`,
    };
  }
  const loadTexture = options.loadTexture ?? ((u: string) => new TextureLoader().loadAsync(u));
  try {
    const texture = await loadTexture(url);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = capabilities.getMaxAnisotropy();
    return { texture };
  } catch (error) {
    return {
      texture: null,
      reason: `could not load ${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

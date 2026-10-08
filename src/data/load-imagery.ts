import { ClampToEdgeWrapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import {
  ImageryInsetManifestSchema,
  type InsetLocalRect,
} from '../../scripts/ingest/imagery-inset-manifest-schema';

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

/** The loaded inset and where it sits on the terrain, or null with why. `absent` is true when no inset is pinned, which is not an error. */
export type InsetResult =
  | { inset: { texture: Texture; rect: InsetLocalRect }; reason?: undefined; absent?: undefined }
  | { inset: null; reason: string; absent: boolean };

export interface LoadInsetOptions {
  /** The decoded data/raw/imagery-inset-manifest.json, or undefined when the file is not in the build. */
  readonly manifestJson: unknown;
  /** The bundled URL of data/raw/naip-inset.jpg, or undefined when the file is not in the build. */
  readonly url: string | undefined;
  readonly capabilities: LoadImageryOptions['capabilities'];
  readonly loadTexture?: LoadImageryOptions['loadTexture'];
}

/**
 * @displayName Imagery inset loader
 * @strategicPurpose Consumer side of the inset pin: parses data/raw/imagery-inset-manifest.json at the boundary and turns data/raw/naip-inset.jpg into the texture the terrain shader mixes over the base photo.
 * @tacticalObjective Parses the manifest with ImageryInsetManifestSchema, loads the jpg through loadImagery with clamp-to-edge wrapping, and returns the texture with its local-metre rect; an unpinned inset returns absent (not an error) and any other failure returns a reason.
 */
export async function loadImageryInset(options: LoadInsetOptions): Promise<InsetResult> {
  const { manifestJson, url, capabilities, loadTexture } = options;
  if (manifestJson === undefined || url === undefined) {
    return { inset: null, reason: 'no native-resolution inset is pinned', absent: true };
  }
  const manifest = ImageryInsetManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    return {
      inset: null,
      absent: false,
      reason: manifest.error.issues.map((i) => i.message).join('; '),
    };
  }
  const result = await loadImagery({
    url,
    capabilities,
    expectedWidth: manifest.data.width,
    ...(loadTexture ? { loadTexture } : {}),
  });
  if (result.texture === null) return { inset: null, reason: result.reason, absent: false };
  result.texture.wrapS = ClampToEdgeWrapping;
  result.texture.wrapT = ClampToEdgeWrapping;
  return { inset: { texture: result.texture, rect: manifest.data.localRect } };
}

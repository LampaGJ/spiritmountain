import { TextureLoader, type Texture } from 'three';
import { TILE_NAMES, type TileName } from './ribbon-kinds';
import adaptive from './patterns/adaptive.png?url';
import downhillRun from './patterns/downhill-run.png?url';
import fatBike from './patterns/fat-bike.png?url';
import hike from './patterns/hike.png?url';
import mtbTrail from './patterns/mtb-trail.png?url';
import nordicClassic from './patterns/nordic-classic.png?url';
import nordicSkate from './patterns/nordic-skate.png?url';
import snowboard from './patterns/snowboard.png?url';
import snowshoe from './patterns/snowshoe.png?url';
import trailRun from './patterns/trail-run.png?url';
import tubing from './patterns/tubing.png?url';

/** Bundled URL of each tile PNG (committed under src/scene/patterns, written by scripts/ui/gen-patterns.mjs). */
const TILE_URLS: Record<TileName, string> = {
  'downhill-run': downhillRun,
  'nordic-classic': nordicClassic,
  'nordic-skate': nordicSkate,
  'mtb-trail': mtbTrail,
  snowboard,
  snowshoe,
  'fat-bike': fatBike,
  hike,
  'trail-run': trailRun,
  tubing,
  adaptive,
};

/**
 * Starts loading all eleven tiles. Each Texture is returned at once and fills in when its image arrives, so the
 * ribbons are built first and gain their pattern a moment later (the layer sets colour space, wrap and matrix).
 */
export function loadRibbonTextures(): Record<TileName, Texture> {
  const loader = new TextureLoader();
  const out = {} as Record<TileName, Texture>;
  for (const name of TILE_NAMES) out[name] = loader.load(TILE_URLS[name]);
  return out;
}

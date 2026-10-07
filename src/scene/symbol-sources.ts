/** The raw text of each tile's abstract symbol SVG (src/scene/symbols/<tile>.svg), bundled by Vite's ?raw import. */
import adaptive from './symbols/adaptive.svg?raw';
import downhillRun from './symbols/downhill-run.svg?raw';
import fatBike from './symbols/fat-bike.svg?raw';
import hike from './symbols/hike.svg?raw';
import mtbTrail from './symbols/mtb-trail.svg?raw';
import nordicClassic from './symbols/nordic-classic.svg?raw';
import nordicSkate from './symbols/nordic-skate.svg?raw';
import snowboard from './symbols/snowboard.svg?raw';
import snowshoe from './symbols/snowshoe.svg?raw';
import trailRun from './symbols/trail-run.svg?raw';
import tubing from './symbols/tubing.svg?raw';
import type { TileName } from './ribbon-kinds';

/** Symbol SVG text per tile, parsed by parseSymbolShapes in symbols.ts (an SVG with no shape throws there). */
export const SYMBOL_SOURCES: Readonly<Record<TileName, string>> = {
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

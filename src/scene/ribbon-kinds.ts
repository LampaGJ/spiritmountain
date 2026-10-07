/**
 * Which tile (ribbon colour plus extruded symbol) a trail shows. Pure (no three import), so it tests in node.
 *
 * Ribbons are keyed by ACTIVITY, not by area kind: an area carries activities in its annotation, the Activity filter
 * selects some, and tileForArea picks one tile per area from those two inputs.
 */
import type { Area, AreaKind } from '../schema/area';
import type { Annotation } from '../schema/annotation';
import type { Activity } from '../ui/filter-predicate';

export const TILE_NAMES = [
  'downhill-run',
  'nordic-classic',
  'nordic-skate',
  'mtb-trail',
  'snowboard',
  'snowshoe',
  'fat-bike',
  'hike',
  'trail-run',
  'tubing',
  'adaptive',
] as const;
export type TileName = (typeof TILE_NAMES)[number];

export interface TileInfo {
  /** The abstract symbol extruded along the trail: src/scene/symbols/<symbol> (viewBox 0 0 100 100). */
  readonly symbol: string;
  /** Drawn ribbon width in metres: the tile's physical width across the trail times symbolScale. */
  readonly widthM: number;
  /** Drawn metres of trail per repeat of the symbol along the trail: the physical period times symbolScale. */
  readonly periodM: number;
  /** Cartographic enlargement applied to this tile (1 = drawn at physical size). See symbolScale. */
  readonly symbolScale: number;
}

/**
 * Physical size per tile, before enlargement. widthM is across the trail (symbol x), periodM along it (symbol y, one
 * symbol per period). nordic-skate's symbol holds two 1.5 m strokes, so its repeat is the full 3 m.
 */
export const TILE_PHYSICAL: Readonly<
  Record<TileName, { readonly widthM: number; readonly periodM: number }>
> = {
  'downhill-run': { widthM: 12, periodM: 1.5 },
  'nordic-classic': { widthM: 4, periodM: 2 },
  'nordic-skate': { widthM: 4, periodM: 3 },
  'mtb-trail': { widthM: 1.5, periodM: 1.2 },
  snowboard: { widthM: 12, periodM: 6 },
  snowshoe: { widthM: 1.5, periodM: 2 },
  'fat-bike': { widthM: 1.5, periodM: 1.2 },
  hike: { widthM: 1.2, periodM: 1.5 },
  'trail-run': { widthM: 1, periodM: 2.4 },
  tubing: { widthM: 12, periodM: 4 },
  adaptive: { widthM: 12, periodM: 4 },
};

/**
 * Smallest drawn repeat along a trail, in metres. A tile drawn at physical size (a 1.2 m tyre tread, a 2 m ski stride)
 * is below a pixel from the chalet and filters to its mean colour, so the trail shows no pattern at all (#37). Twelve
 * metres is about twenty pixels at 500 m in the resort view; Graham judged 6 m "too small" on the live site.
 */
export const RIBBON_MIN_PERIOD_M = 12;
/** No tile is drawn wider than this, so a run ribbon never swallows the slope beside it. */
export const RIBBON_MAX_WIDTH_M = 20;
/** Cap on the enlargement, so a tiny physical tile cannot become a road. */
export const RIBBON_MAX_SCALE = 10;

/**
 * Cartographic enlargement for a tile: the factor that lifts its period to RIBBON_MIN_PERIOD_M, at most RIBBON_MAX_SCALE,
 * reduced so the width stays within RIBBON_MAX_WIDTH_M, never below 1. Width and period scale together, so the
 * symbol's aspect is unchanged.
 */
export function symbolScale(physical: {
  readonly widthM: number;
  readonly periodM: number;
}): number {
  const forPeriod = Math.min(RIBBON_MAX_SCALE, Math.max(1, RIBBON_MIN_PERIOD_M / physical.periodM));
  const forWidth = Math.max(1, RIBBON_MAX_WIDTH_M / physical.widthM);
  return Math.min(forPeriod, forWidth);
}

/** Every tile at its drawn size: the physical table enlarged by symbolScale, width and period together. */
export function scaleTiles(
  physical: Readonly<Record<TileName, { readonly widthM: number; readonly periodM: number }>>,
): Record<TileName, TileInfo> {
  const out = {} as Record<TileName, TileInfo>;
  for (const name of TILE_NAMES) {
    const tile = physical[name];
    const scale = symbolScale(tile);
    out[name] = {
      symbol: `${name}.svg`,
      widthM: tile.widthM * scale,
      periodM: tile.periodM * scale,
      symbolScale: scale,
    };
  }
  return out;
}

export const TILES: Record<TileName, TileInfo> = scaleTiles(TILE_PHYSICAL);

/**
 * The tile each activity draws. lift-ride has no tile: lifts stay cables. A Record over the activity enum, so a new
 * activity in ActivitySchema is a compile error here.
 */
export const ACTIVITY_TILE: Record<Activity, TileName | null> = {
  'alpine-ski': 'downhill-run',
  snowboard: 'snowboard',
  'nordic-classic': 'nordic-classic',
  'nordic-skate': 'nordic-skate',
  snowshoe: 'snowshoe',
  'fat-bike': 'fat-bike',
  'mountain-bike': 'mtb-trail',
  hike: 'hike',
  'trail-run': 'trail-run',
  tubing: 'tubing',
  'lift-ride': null,
  adaptive: 'adaptive',
};

/**
 * The activity an area is assumed to carry when its annotation names none that has a tile (or there is no annotation).
 * snow-park falls back to alpine-ski, so it reuses the downhill-run tile (no jump-lip tile exists).
 */
export const KIND_DEFAULT_ACTIVITY: Record<AreaKind, Activity | null> = {
  'downhill-run': 'alpine-ski',
  'nordic-trail': 'nordic-classic',
  'mtb-trail': 'mountain-bike',
  'mtb-route': 'mountain-bike',
  'snow-park': 'alpine-ski',
  lift: null,
};

/**
 * The tile one area shows, or null when it has none (lifts).
 * Exactly one activity selected and carried by the area: that activity's tile. Otherwise (none selected, several
 * selected, or the one selected is not carried): the tile of the area's first annotated activity that has a tile.
 * An area with no such activity falls back to its kind's default activity.
 */
export function tileForArea(
  area: Pick<Area, 'kind'>,
  annotation: Annotation | undefined,
  selected: ReadonlySet<Activity>,
): TileName | null {
  if (area.kind === 'lift') return null;
  const carried: Activity[] = annotation
    ? annotation.activities.map((entry) => entry.activity)
    : [];
  if (selected.size === 1) {
    const [only] = selected;
    if (only !== undefined && carried.includes(only)) {
      const tile = ACTIVITY_TILE[only];
      if (tile !== null) return tile;
    }
  }
  for (const activity of carried) {
    const tile = ACTIVITY_TILE[activity];
    if (tile !== null) return tile;
  }
  const fallback = KIND_DEFAULT_ACTIVITY[area.kind];
  return fallback === null ? null : ACTIVITY_TILE[fallback];
}

/** The side-wall base colour per tile (sRGB hex): snow tiles share a cool snow edge, dirt tiles the warm dirt edge. */
const SNOW_EDGE = '#c3d2e6';
const DIRT_EDGE = '#7a5a36';
export const TILE_EDGE_COLOR: Record<TileName, string> = {
  'downhill-run': SNOW_EDGE,
  'nordic-classic': SNOW_EDGE,
  'nordic-skate': SNOW_EDGE,
  snowboard: SNOW_EDGE,
  snowshoe: SNOW_EDGE,
  'fat-bike': SNOW_EDGE,
  tubing: SNOW_EDGE,
  adaptive: SNOW_EDGE,
  'mtb-trail': DIRT_EDGE,
  hike: DIRT_EDGE,
  'trail-run': DIRT_EDGE,
};

/** The ribbon top per tile (sRGB hex), drawn unlit: near-white snow, tan dirt. The symbol stands on it. */
const SNOW_TOP = '#f4f7fb';
const DIRT_TOP = '#c8a878';
export const RIBBON_TOP_COLOR: Record<TileName, string> = {
  'downhill-run': SNOW_TOP,
  'nordic-classic': SNOW_TOP,
  'nordic-skate': SNOW_TOP,
  snowboard: SNOW_TOP,
  snowshoe: SNOW_TOP,
  'fat-bike': SNOW_TOP,
  tubing: SNOW_TOP,
  adaptive: SNOW_TOP,
  'mtb-trail': DIRT_TOP,
  hike: DIRT_TOP,
  'trail-run': DIRT_TOP,
};

/**
 * The extruded symbol per tile (sRGB hex): deep blue on snow, dark umber on dirt, teal for adaptive, orange for tubing.
 */
const SNOW_MOTIF = '#1d3f8f';
const DIRT_MOTIF = '#4a2f17';
export const SYMBOL_COLOR: Record<TileName, string> = {
  'downhill-run': SNOW_MOTIF,
  'nordic-classic': SNOW_MOTIF,
  'nordic-skate': SNOW_MOTIF,
  snowboard: SNOW_MOTIF,
  snowshoe: SNOW_MOTIF,
  'fat-bike': SNOW_MOTIF,
  tubing: '#e8741e',
  adaptive: '#0f8a8a',
  'mtb-trail': DIRT_MOTIF,
  hike: DIRT_MOTIF,
  'trail-run': DIRT_MOTIF,
};

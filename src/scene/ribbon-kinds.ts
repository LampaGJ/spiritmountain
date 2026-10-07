/**
 * Which pattern tile a trail ribbon shows. Pure (no three import), so it tests in node.
 *
 * Ribbons are keyed by ACTIVITY, not by area kind: an area carries activities in its annotation, the Activity filter
 * selects some, and tileForArea picks one tile per area from those two inputs.
 */
import { z } from 'zod';
import type { Area, AreaKind } from '../schema/area';
import type { Annotation } from '../schema/annotation';
import type { Activity } from '../ui/filter-predicate';
import patternsJson from './patterns/patterns.json';

/**
 * @displayName Ribbon pattern manifest
 * @strategicPurpose Carries each tile's world size and checksum from the rasteriser (scripts/ui/gen-patterns.mjs, the
 *   emitter) to the scene (this file, the consumer), so a ribbon's width and repeat come from the same numbers the PNG was drawn at.
 * @tacticalObjective Parses patterns.json once: per tile the PNG file name, world width across, repeat period along,
 *   pixel size and the sha256 of the SVG and the PNG. A missing tile is a parse error, never an empty list.
 */
export const PatternManifestSchema = z.strictObject({
  tiles: z.record(
    z.string(),
    z.strictObject({
      file: z.string().min(1),
      widthM: z.number().positive(),
      periodM: z.number().positive(),
      widthPx: z.number().int().positive(),
      heightPx: z.number().int().positive(),
      svgSha256: z.string().length(64),
      pngSha256: z.string().length(64),
    }),
  ),
});
export type PatternManifest = z.infer<typeof PatternManifestSchema>;

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
  readonly file: string;
  /** Ribbon width in metres (the tile's world size across the trail). */
  readonly widthM: number;
  /** Metres of trail per repeat of the tile along the trail. */
  readonly periodM: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** The parsed manifest tiles, keyed by tile name. Throws when the manifest is malformed or lacks a tile in TILE_NAMES. */
export function parseTiles(json: unknown): Record<TileName, TileInfo> {
  const parsed = PatternManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`patterns.json: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const out = {} as Record<TileName, TileInfo>;
  for (const name of TILE_NAMES) {
    const tile = parsed.data.tiles[name];
    if (tile === undefined) throw new Error(`patterns.json has no tile ${name}`);
    out[name] = tile;
  }
  return out;
}

export const TILES: Record<TileName, TileInfo> = parseTiles(patternsJson);

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

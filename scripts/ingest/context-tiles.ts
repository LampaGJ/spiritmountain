import rawManifestJson from '../../data/raw/manifest.json';
import { ManifestSchema } from './manifest-schema';

/**
 * @displayName Context tile table
 * @strategicPurpose One declaration of which tiles surround the resort tile, so the ingest scripts, the loader, the scene and the fade cannot disagree about the set or the geometry.
 * @tacticalObjective Exports the 12 tile offsets (i east, j north, in whole tile widths and heights), tileBox(i, j) in EPSG:26915 metres, the tile size derived from the pinned 3DEP box, and the radial fade constants and fadeAlpha.
 *
 * The table is data, not code: adding the eight knight tiles (plus or minus 2, plus or minus 1) and (plus or minus 1, plus or minus 2) is eight more rows.
 */

const centre = ManifestSchema.parse(rawManifestJson).threeDep.decodedBbox26915;

/** The centre tile box (the pinned 3DEP box), EPSG:26915 metres. */
export const CENTRE_BOX = {
  xmin: centre.xmin,
  ymin: centre.ymin,
  xmax: centre.xmax,
  ymax: centre.ymax,
} as const;

/** Tile width (east-west) and height (north-south) in metres, from the manifest box. */
export const TILE_WIDTH_M = CENTRE_BOX.xmax - CENTRE_BOX.xmin;
export const TILE_HEIGHT_M = CENTRE_BOX.ymax - CENTRE_BOX.ymin;

/** The 12 context tiles as [i, j]: i whole tile widths east, j whole tile heights north of the centre tile. */
export const CONTEXT_TILES: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 2],
  [0, -2],
  [2, 0],
  [-2, 0],
];

/** Stable tile key used in file names: "<i>_<j>", for example "-1_1". */
export function tileKey(i: number, j: number): string {
  return `${i}_${j}`;
}

export interface TileBox {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

/** EPSG:26915 box of tile (i, j): the centre box offset by i widths east and j heights north. */
export function tileBox(i: number, j: number): TileBox {
  const dx = i * TILE_WIDTH_M;
  const dy = j * TILE_HEIGHT_M;
  return {
    xmin: CENTRE_BOX.xmin + dx,
    ymin: CENTRE_BOX.ymin + dy,
    xmax: CENTRE_BOX.xmax + dx,
    ymax: CENTRE_BOX.ymax + dy,
  };
}

/** Requested resolutions in metres per pixel: context terrain and context imagery. */
export const CONTEXT_TERRAIN_M_PER_PX = 30;
export const CONTEXT_IMAGERY_M_PER_PX = 10;

/** Pixel size of a tile at a nominal resolution: the box divided by the resolution, rounded. */
export function pixelSize(metresPerPixel: number): { width: number; height: number } {
  return {
    width: Math.round(TILE_WIDTH_M / metresPerPixel),
    height: Math.round(TILE_HEIGHT_M / metresPerPixel),
  };
}

/** Alpha is 1 at and inside this distance (metres) from the fade centre. */
export const FADE_INNER_M = 4000;
/**
 * Alpha is 0 at and beyond this distance. 10100 m is just under 1.5 x the tile height (10110 m), the inscribed
 * radius of the 3 x 3 block: the largest circle the eight ring tiles cover completely, set by the block's diagonals.
 * The four cardinal arm tiles reach 2.5 tile sizes along the axes only, so they add no fully covered radius; the
 * eight missing knight tiles (plus or minus 2, plus or minus 1) and (plus or minus 1, plus or minus 2) would raise it to about 14.7 km.
 * Until those are added the fade must end inside 10.1 km, or the circle would show uncovered gaps.
 */
export const FADE_OUTER_M = 10100;

/** Pure fade curve: 1 inside the inner radius, 0 at and beyond the outer radius, smoothstep between. */
export function fadeAlpha(distanceM: number, innerM = FADE_INNER_M, outerM = FADE_OUTER_M): number {
  if (distanceM <= innerM) return 1;
  if (distanceM >= outerM) return 0;
  const t = (distanceM - innerM) / (outerM - innerM);
  return 1 - t * t * (3 - 2 * t);
}

import proj4 from 'proj4';
import './local-frame'; // registers EPSG:26915 with proj4

/**
 * The seam between the two USGS EPT datasets: MN_LakeSuperior_2_2021 has no points east of this EPSG:3857 x
 * (its ept.json bounds say -10262419, but the data stops here, which the core window's nodata stripe showed),
 * and MN_LakeSuperior_1_2021 starts here.
 */
export const SEAM_X_3857 = -10264000;

/** The original terrain square in absolute EPSG:26915 metres (the 3DEP bare-earth DEM extent). */
export const SQUARE_UTM = { xmin: 556530, ymin: 5169870, xmax: 563480, ymax: 5176610 } as const;

/**
 * Absolute EPSG:26915 easting of the dataset seam (a straight line in EPSG:3857) at the given northing, by linear
 * interpolation between two projected points of the line; UTM grid convergence tilts it by tens of metres over the square.
 */
export function seamEastingAtNorthing(northing: number): number {
  const a = proj4('EPSG:3857', 'EPSG:26915', [SEAM_X_3857, 5_880_000]);
  const b = proj4('EPSG:3857', 'EPSG:26915', [SEAM_X_3857, 5_910_000]);
  const t = (northing - (a[1] as number)) / ((b[1] as number) - (a[1] as number));
  return (a[0] as number) + t * ((b[0] as number) - (a[0] as number));
}

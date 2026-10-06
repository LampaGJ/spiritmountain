import proj4 from 'proj4';
import { FrameSchema, type Frame } from '../../src/schema/frame';

/**
 * Shared bbox and local metric frame for the whole pipeline (#7 fetch, #8 areas, #9 terrain).
 * Axis order differs per consumer, a known trap:
 *   Overpass takes (south,west,north,east); ArcGIS takes xmin,ymin,xmax,ymax; proj4 takes [lon, lat].
 * This module is deterministic: no clock, no randomness, no locale-sensitive sorting.
 */

/** NAD83 / UTM zone 15N. proj4 2.22.0 does not know this code by default, so it is registered here. */
export const EPSG_26915_DEF = '+proj=utm +zone=15 +datum=NAD83 +units=m +no_defs';
proj4.defs('EPSG:26915', EPSG_26915_DEF);

/**
 * @displayName Spirit Mountain bounding box
 * @strategicPurpose One declaration of the study area so Overpass, 3DEP and the transforms cannot disagree.
 * @tacticalObjective Holds south, west, north, east in degrees (EPSG:4326).
 */
export const BBOX = { south: 46.68, west: -92.26, north: 46.74, east: -92.17 } as const;

/** Bbox centre, computed from BBOX and never retyped. */
export const LON0 = (BBOX.west + BBOX.east) / 2;
export const LAT0 = (BBOX.south + BBOX.north) / 2;

/**
 * UTM 15N position of (LON0, LAT0) in metres, full double precision. A test asserts these literals
 * equal proj4's projection of the centre to 1e-6 m, so the literal and the computation cannot drift.
 */
export const ORIGIN = { easting: 560002.112255701, northing: 5173237.48355887 } as const;

/** Project lon/lat degrees to absolute EPSG:26915 metres: [easting, northing]. */
export function projectToUtm(lon: number, lat: number): [number, number] {
  const [x, y] = proj4('EPSG:4326', 'EPSG:26915', [lon, lat]);
  return [x as number, y as number];
}

/** Project lon/lat degrees to local metres: [east, north], relative to ORIGIN. */
export function toLocal(lon: number, lat: number): [number, number] {
  const [x, y] = projectToUtm(lon, lat);
  return [x - ORIGIN.easting, y - ORIGIN.northing];
}

/**
 * A lon/lat rectangle is not a UTM rectangle. This projects the four BBOX corners, takes the
 * envelope, then snaps it outward to multiples of `metresPerPixel`, so every pixel is exactly
 * metresPerPixel square and width/height are integers.
 */
export function gridEnvelope(bbox: typeof BBOX, metresPerPixel: number) {
  const corners = [
    projectToUtm(bbox.west, bbox.south),
    projectToUtm(bbox.east, bbox.south),
    projectToUtm(bbox.west, bbox.north),
    projectToUtm(bbox.east, bbox.north),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const xmin = Math.floor(Math.min(...xs) / metresPerPixel) * metresPerPixel;
  const xmax = Math.ceil(Math.max(...xs) / metresPerPixel) * metresPerPixel;
  const ymin = Math.floor(Math.min(...ys) / metresPerPixel) * metresPerPixel;
  const ymax = Math.ceil(Math.max(...ys) / metresPerPixel) * metresPerPixel;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    width: Math.round((xmax - xmin) / metresPerPixel),
    height: Math.round((ymax - ymin) / metresPerPixel),
  };
}

/**
 * @displayName Frame constant
 * @strategicPurpose The single in-code value serialised to data/frame.json.
 * @tacticalObjective Parsed through FrameSchema at module load so a bad edit fails on import.
 */
export const FRAME: Frame = FrameSchema.parse({
  version: 1,
  epsg: 26915,
  proj4Def: EPSG_26915_DEF,
  origin: { easting: ORIGIN.easting, northing: ORIGIN.northing },
  centre: { lon: LON0, lat: LAT0 },
  bbox: { ...BBOX },
  axes: 'x east, y north, z elevation; metres; local = absolute UTM minus origin',
});

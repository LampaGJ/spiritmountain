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

/** Project NAD83 lon/lat degrees to absolute EPSG:26915 metres: [easting, northing]. No datum shift. */
export function projectToUtm(lon: number, lat: number): [number, number] {
  const [x, y] = proj4('EPSG:4326', 'EPSG:26915', [lon, lat]);
  return [x as number, y as number];
}

/**
 * Project NAD83 lon/lat degrees to local metres: [east, north], relative to ORIGIN. This is the frame
 * projection: it applies no datum shift, so use it for NAD83 inputs (3DEP, NAIP, LiDAR probe points) and
 * for the frame constants. OSM coordinates go through osmToLocal instead.
 */
export function toLocal(lon: number, lat: number): [number, number] {
  const [x, y] = projectToUtm(lon, lat);
  return [x - ORIGIN.easting, y - ORIGIN.northing];
}

/**
 * @displayName ITRF2014 to NAD83(2011) Helmert parameters
 * @strategicPurpose OSM is WGS84, which at current realisations (G1762, G2139) agrees with ITRF2014 to centimetres,
 *   while 3DEP and NAIP are NAD83(2011). Treating the two as identical misplaces every OSM feature by about 1.2 m at
 *   Duluth (#77).
 * @tacticalObjective Holds the 15 published parameters of EPSG:8970, "ITRF2014 to NAD83(2011) (1)", method
 *   "Time-dependent Coordinate Frame rotation (geocen)" (EPSG 1056), reference epoch 2010.0. Translations in metres,
 *   rotations in milliarcseconds, scale in parts per billion; rates per year.
 *   Source: https://epsg.io/8970 (EPSG registry entry; PROJ 9.9.0 `projinfo -s EPSG:7789 -t EPSG:6318` prints the
 *   same 15 values). EPSG describes it as NAD83(CORS96) to ITRF96 (EPSG:6864) chained with the IGS and IERS ITRF96 to
 *   ITRF2014 parameters, https://itrf.ign.fr/docs/solutions/itrf2014/Transfo-ITRF2014_ITRFs.txt . The NGS tool for
 *   this transformation is HTDP, https://geodesy.noaa.gov/TOOLS/Htdp/Htdp.shtml (Pearson and Snay 2013,
 *   https://doi.org/10.1007/s10291-012-0255-y ). Verification and epoch choice: docs/datum.md.
 */
export const ITRF2014_TO_NAD83_2011 = {
  epsg: 8970,
  referenceEpoch: 2010.0,
  tx: 1.0053,
  ty: -1.90921,
  tz: -0.54157,
  rxMas: 26.78138,
  ryMas: -0.42027,
  rzMas: 10.93206,
  sPpb: 0.36891,
  dtx: 0.00079,
  dty: -0.0006,
  dtz: -0.00144,
  drxMas: 0.06667,
  dryMas: -0.75744,
  drzMas: -0.05133,
  dsPpb: -0.07201,
} as const;

/**
 * Epoch at which OSM coordinates are taken to be ITRF2014 positions: 2010.0, the NAD83(2011) anchor epoch, so
 * the rate terms vanish and the shift is the epoch-2010 one. A later epoch moves the shift by about 0.02 m per year
 * at Duluth (0.33 m east at 2026.77); see docs/datum.md.
 */
export const OSM_EPOCH = 2010.0;

const GRS80_GEOGRAPHIC = '+proj=longlat +ellps=GRS80 +towgs84=0,0,0 +no_defs';
const GRS80_GEOCENTRIC = '+proj=geocent +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs';
const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

/**
 * Transform ITRF2014 (OSM WGS84) lon/lat degrees at `epoch` to NAD83(2011) lon/lat degrees, ellipsoidal height 0.
 * proj4 does the geographic to geocentric conversions (GRS80, which both frames use); the 7-parameter
 * time-dependent Helmert in between is applied here because proj4js has no time-dependent method.
 * Coordinate frame rotation convention (EPSG 1032/1056), small-angle form, as PROJ applies EPSG:8970:
 *   X' = T + (1 + s) [[1, rz, -ry], [-rz, 1, rx], [ry, -rx, 1]] X
 */
export function itrf2014ToNad83(
  lon: number,
  lat: number,
  epoch: number = OSM_EPOCH,
): [number, number] {
  const p = ITRF2014_TO_NAD83_2011;
  const dt = epoch - p.referenceEpoch;
  const tx = p.tx + p.dtx * dt;
  const ty = p.ty + p.dty * dt;
  const tz = p.tz + p.dtz * dt;
  const rx = (p.rxMas + p.drxMas * dt) * MAS_TO_RAD;
  const ry = (p.ryMas + p.dryMas * dt) * MAS_TO_RAD;
  const rz = (p.rzMas + p.drzMas * dt) * MAS_TO_RAD;
  const k = 1 + (p.sPpb + p.dsPpb * dt) * 1e-9;
  const [x, y, z] = proj4(GRS80_GEOGRAPHIC, GRS80_GEOCENTRIC, [lon, lat, 0]) as number[];
  const xs = x as number;
  const ys = y as number;
  const zs = z as number;
  const x2 = tx + k * (xs + rz * ys - ry * zs);
  const y2 = ty + k * (-rz * xs + ys + rx * zs);
  const z2 = tz + k * (ry * xs - rx * ys + zs);
  const [lon2, lat2] = proj4(GRS80_GEOCENTRIC, GRS80_GEOGRAPHIC, [x2, y2, z2]) as number[];
  return [lon2 as number, lat2 as number];
}

/** Project OSM (ITRF2014 / WGS84) lon/lat degrees to absolute EPSG:26915 NAD83(2011) metres: [easting, northing]. */
export function projectOsmToUtm(lon: number, lat: number): [number, number] {
  const [nadLon, nadLat] = itrf2014ToNad83(lon, lat);
  return projectToUtm(nadLon, nadLat);
}

/**
 * Project OSM (ITRF2014 / WGS84) lon/lat degrees to local metres: [east, north], relative to ORIGIN.
 * ORIGIN itself stays the unshifted projection of the bbox centre: it is a constant offset, so it only has to be
 * the same number everywhere, and the NAD83 rasters already share it.
 */
export function osmToLocal(lon: number, lat: number): [number, number] {
  const [x, y] = projectOsmToUtm(lon, lat);
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

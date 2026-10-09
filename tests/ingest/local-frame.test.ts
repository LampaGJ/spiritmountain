import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import {
  BBOX,
  EPSG_26915_DEF,
  FRAME,
  LAT0,
  LON0,
  ORIGIN,
  OSM_EPOCH,
  gridEnvelope,
  itrf2014ToNad83,
  osmToLocal,
  projectOsmToUtm,
  projectToUtm,
  toLocal,
} from '../../scripts/ingest/local-frame';
import { FrameSchema } from '../../src/schema/frame';

describe('local-frame', () => {
  it('toLocal at the bbox centre is [0, 0] within 1e-6 m', () => {
    const [x, y] = toLocal(LON0, LAT0);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it('ORIGIN literal equals proj4 projection of the centre to 1e-6 m', () => {
    proj4.defs('EPSG:26915', EPSG_26915_DEF);
    const [x, y] = proj4('EPSG:4326', 'EPSG:26915', [LON0, LAT0]);
    expect(Math.abs((x as number) - ORIGIN.easting)).toBeLessThan(1e-6);
    expect(Math.abs((y as number) - ORIGIN.northing)).toBeLessThan(1e-6);
  });

  it('south-west corner matches an independent Kruger-series UTM 15N value to 1e-2 m', () => {
    // Independent of proj4: Karney 2011 Kruger series on GRS80, computed 2026-10-06.
    const [x, y] = projectToUtm(BBOX.west, BBOX.south);
    expect(Math.abs(x - 556593.8455227205)).toBeLessThan(1e-2);
    expect(Math.abs(y - 5169870.565807056)).toBeLessThan(1e-2);
  });

  it('gridEnvelope at 5 m snaps the projected corners outward to a 1390 x 1348 grid', () => {
    expect(gridEnvelope(BBOX, 5)).toEqual({
      xmin: 556530,
      ymin: 5169870,
      xmax: 563480,
      ymax: 5176610,
      width: 1390,
      height: 1348,
    });
  });

  it('FRAME parses as a frame file and carries EPSG 26915', () => {
    expect(FrameSchema.parse(FRAME).epsg).toBe(26915);
  });

  it('contains no determinism hazard', () => {
    const src = readFileSync('scripts/ingest/local-frame.ts', 'utf8');
    for (const hazard of ['Date.now', 'Math.random', 'localeCompare'])
      expect(src).not.toContain(hazard);
  });
});

describe('ITRF2014 (OSM WGS84) to NAD83(2011) datum shift (#77)', () => {
  // Independent reference: PROJ 9.9.0 (Homebrew) with the EPSG registry's EPSG:8970, "ITRF2014 to NAD83(2011) (1)",
  // run 2026-10-08:
  //   echo '46.71 -92.215 0 2010.0' | cs2cs -d 6 EPSG:9000 EPSG:6344   -> 560002.953299 5173236.587037
  //   echo '46.71 -92.215 0 2010.0' | cs2cs -d 9 EPSG:9000 EPSG:6318   -> 46.709991857 -92.214989115
  //   echo '46.71 -92.215 0 2026.77' | cs2cs -d 6 EPSG:9000 EPSG:6344  -> 560003.268135 5173236.616329
  // Against the unshifted ORIGIN that is (+0.841, -0.897) m at epoch 2010.0.
  const PROJ_UTM_2010: readonly [number, number] = [560002.953299, 5173236.587037];

  it('moves the bbox centre by the PROJ EPSG:8970 vector within 0.05 m at epoch 2010.0', () => {
    const [e, n] = projectOsmToUtm(LON0, LAT0);
    expect(Math.abs(e - PROJ_UTM_2010[0])).toBeLessThan(0.05);
    expect(Math.abs(n - PROJ_UTM_2010[1])).toBeLessThan(0.05);
    const [x, y] = osmToLocal(LON0, LAT0);
    expect(Math.abs(x - (PROJ_UTM_2010[0] - ORIGIN.easting))).toBeLessThan(0.05);
    expect(Math.abs(y - (PROJ_UTM_2010[1] - ORIGIN.northing))).toBeLessThan(0.05);
  });

  it('agrees with PROJ geographic NAD83(2011) to 1e-7 degrees (about a centimetre)', () => {
    const [lon, lat] = itrf2014ToNad83(LON0, LAT0);
    expect(Math.abs(lon - -92.214989115)).toBeLessThan(1e-7);
    expect(Math.abs(lat - 46.709991857)).toBeLessThan(1e-7);
  });

  it('is time-dependent: at epoch 2026.77 it matches PROJ within 0.05 m', () => {
    const [lon, lat] = itrf2014ToNad83(LON0, LAT0, 2026.77);
    const [e, n] = projectToUtm(lon, lat);
    expect(Math.abs(e - 560003.268135)).toBeLessThan(0.05);
    expect(Math.abs(n - 5173236.616329)).toBeLessThan(0.05);
  });

  it('uses epoch 2010.0 for OSM, the NAD83(2011) anchor epoch', () => {
    expect(OSM_EPOCH).toBe(2010.0);
  });

  it('leaves the frame projection (toLocal, ORIGIN) on NAD83 with no shift', () => {
    const [x, y] = toLocal(LON0, LAT0);
    expect(Math.hypot(x, y)).toBeLessThan(1e-6);
  });
});

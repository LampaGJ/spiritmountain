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
  gridEnvelope,
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

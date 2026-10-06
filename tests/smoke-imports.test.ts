import { fromArrayBuffer } from 'geotiff';
import osmtogeojson from 'osmtogeojson';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';

// Interop smoke tests: osmtogeojson is old CommonJS (and a beta), so confirm Vitest can import
// it before the transform issue depends on it. Each test also proves the instrument can detect
// presence: an empty result alone would look the same as a broken parser (user CLAUDE.md:29),
// so one test feeds a real element and expects one feature.
describe('dependency import smoke', () => {
  it('osmtogeojson converts an empty and a one-node Overpass document', () => {
    const empty = osmtogeojson({ elements: [] });
    expect(empty.features).toHaveLength(0);
    const one = osmtogeojson({
      elements: [{ type: 'node', id: 1, lat: 46.7, lon: -92.2, tags: { natural: 'peak' } }],
    });
    expect(one.features).toHaveLength(1);
  });

  it('proj4 projects WGS84 to Web Mercator', () => {
    const [x, y] = proj4('EPSG:4326', 'EPSG:3857', [-92.2, 46.7]);
    expect(x).toBeCloseTo(-10263400, -3);
    expect(y).toBeGreaterThan(5000000);
  });

  it('geotiff exports a parser and rejects a non-TIFF buffer', async () => {
    expect(typeof fromArrayBuffer).toBe('function');
    await expect(fromArrayBuffer(new ArrayBuffer(8))).rejects.toThrow();
  });
});

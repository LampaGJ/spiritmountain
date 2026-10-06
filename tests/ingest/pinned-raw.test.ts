import { readFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../scripts/ingest/replay';
import { BBOX, gridEnvelope } from '../../scripts/ingest/local-frame';
import { ManifestSchema } from '../../scripts/ingest/manifest-schema';
import { validateOverpass } from '../../scripts/ingest/fetch';

// Reads the committed pins. Fails (not skips) when they are missing: a skipped check would read as a pass.
const manifest = ManifestSchema.parse(JSON.parse(readFileSync('data/raw/manifest.json', 'utf8')));
const overpass = readFileSync('data/raw/overpass.json');
const tif = readFileSync('data/raw/3dep.tif');

describe('pinned raw inputs', () => {
  it('sha256 and byteLength match the manifest', () => {
    expect(sha256Hex(overpass)).toBe(manifest.overpass.sha256);
    expect(overpass.byteLength).toBe(manifest.overpass.byteLength);
    expect(sha256Hex(tif)).toBe(manifest.threeDep.sha256);
    expect(tif.byteLength).toBe(manifest.threeDep.byteLength);
    expect(tif.byteLength).toBeLessThanOrEqual(20_000_000);
  });
  it('queryFileSha256 matches the committed query, whose final line is out geom; and whose bbox equals BBOX', () => {
    const q = readFileSync('scripts/ingest/overpass.ql', 'utf8');
    expect(sha256Hex(q)).toBe(manifest.overpass.queryFileSha256);
    expect(q.trimEnd().split('\n').pop()).toBe('out geom;');
    const boxes = new Set(q.match(/\(-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+\)/g));
    expect([...boxes]).toEqual([`(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})`]);
  });
  it('every way carries geometry and the family counts equal the manifest', () => {
    const r = validateOverpass(new Uint8Array(overpass));
    expect(r.counts).toEqual(manifest.overpass.counts);
  });
  it('the TIFF is Float32 in EPSG:26915 on the frame grid', async () => {
    const ab = tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength) as ArrayBuffer;
    const image = await (await fromArrayBuffer(ab)).getImage();
    expect(image.getGeoKeys()?.ProjectedCSTypeGeoKey).toBe(26915);
    expect(image.getBitsPerSample(0)).toBe(32);
    expect(image.getSampleFormat(0)).toBe(3);
    const g = gridEnvelope(BBOX, manifest.threeDep.metresPerPixel);
    expect([image.getWidth(), image.getHeight()]).toEqual([g.width, g.height]);
    expect(image.getBoundingBox()).toEqual([g.xmin, g.ymin, g.xmax, g.ymax]);
  });
});

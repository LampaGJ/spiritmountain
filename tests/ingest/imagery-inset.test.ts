import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAreas } from '../../src/data/load-areas';
import { focusBoxOf } from '../../src/scene/views';
import {
  INSET_METRES_PER_PIXEL,
  INSET_PIXELS,
  runImageryInset,
} from '../../scripts/ingest/imagery-inset';
import { ImageryInsetManifestSchema } from '../../scripts/ingest/imagery-inset-manifest-schema';
import { sha256Hex } from '../../scripts/ingest/replay';

/** A minimal byte sequence with a JPEG start-of-frame marker: enough for jpegSize, not decodable. */
function fakeJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

function sandbox() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'imagery-inset-'));
  mkdirSync(path.join(dataDir, 'raw'));
  copyFileSync('data/raw/manifest.json', path.join(dataDir, 'raw/manifest.json'));
  copyFileSync('data/frame.json', path.join(dataDir, 'frame.json'));
  copyFileSync('data/areas.geojson', path.join(dataDir, 'areas.geojson'));
  return dataDir;
}

const respond = (body: Uint8Array, type = 'image/jpeg', status = 200) => {
  const urls: string[] = [];
  const fetchImpl = (url: string) => {
    urls.push(url);
    return Promise.resolve(
      new Response(body as BodyInit, { status, headers: { 'content-type': type } }),
    );
  };
  return { fetchImpl, urls };
};

describe('runImageryInset', () => {
  it('requests a square box centred on the resort focus, writes the jpg, and a manifest that parses and matches', async () => {
    const dataDir = sandbox();
    const { fetchImpl, urls } = respond(fakeJpeg(INSET_PIXELS, INSET_PIXELS));
    const m = await runImageryInset({ dataDir, fetchImpl, now: () => 0 });

    const q = new URL(urls[0] as string).searchParams;
    expect(q.get('size')).toBe(`${INSET_PIXELS},${INSET_PIXELS}`);
    expect(q.get('bboxSR')).toBe('26915');
    expect(q.get('imageSR')).toBe('26915');
    expect(q.get('format')).toBe('jpg');
    expect(q.get('compressionQuality')).toBe('75');

    const focus = focusBoxOf(
      parseAreas(JSON.parse(readFileSync('data/areas.geojson', 'utf8'))).map((area) => ({ area })),
    );
    expect(focus).not.toBeNull();
    const centreEast = (m.localRect.minEast + m.localRect.maxEast) / 2;
    const centreNorth = (m.localRect.minNorth + m.localRect.maxNorth) / 2;
    expect(Math.abs(centreEast - (focus!.minEast + focus!.maxEast) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(centreNorth - (focus!.minNorth + focus!.maxNorth) / 2)).toBeLessThanOrEqual(
      0.5,
    );
    expect(m.localRect.maxEast - m.localRect.minEast).toBeCloseTo(
      INSET_PIXELS * INSET_METRES_PER_PIXEL,
      6,
    );
    expect(m.metresPerPixel).toBeCloseTo(INSET_METRES_PER_PIXEL, 6);

    const written = readFileSync(path.join(dataDir, 'raw/naip-inset.jpg'));
    expect(sha256Hex(written)).toBe(m.sha256);
    const onDisk = ImageryInsetManifestSchema.parse(
      JSON.parse(readFileSync(path.join(dataDir, 'raw/imagery-inset-manifest.json'), 'utf8')),
    );
    expect(onDisk).toEqual(m);
  });

  it('refuses to overwrite without force (AlreadyPinned), and --force supersedes', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(fakeJpeg(INSET_PIXELS, INSET_PIXELS));
    await runImageryInset({ dataDir, fetchImpl });
    await expect(runImageryInset({ dataDir, fetchImpl })).rejects.toMatchObject({
      code: 'AlreadyPinned',
    });
    await expect(runImageryInset({ dataDir, fetchImpl, force: true })).resolves.toBeTruthy();
  });

  it('rejects a 200 JSON error body by content type and writes nothing', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(
      new TextEncoder().encode('{"error":{"code":400,"message":"bad size"}}'),
      'application/json',
    );
    await expect(runImageryInset({ dataDir, fetchImpl })).rejects.toThrow(/ImageryNotJpeg/);
    expect(existsSync(path.join(dataDir, 'raw/naip-inset.jpg'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'raw/imagery-inset-manifest.json'))).toBe(false);
  });

  it('rejects an image whose size is not the requested size', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(fakeJpeg(1000, 900));
    await expect(runImageryInset({ dataDir, fetchImpl })).rejects.toThrow(
      /ImageryBadSize: image is 1000x900, requested 4000x4000/,
    );
    expect(existsSync(path.join(dataDir, 'raw/imagery-inset-manifest.json'))).toBe(false);
  });
});

describe('ImageryInsetManifestSchema', () => {
  const valid = {
    version: 1,
    name: 'naip-inset',
    path: 'data/raw/naip-inset.jpg',
    url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage',
    method: 'GET',
    params: { compressionQuality: '75' },
    requestHeaders: { userAgent: 'spiritmountain-poc/0.1' },
    httpStatus: 200,
    contentType: 'image/jpeg',
    fetchedAt: '2026-10-08T20:00:00.000Z',
    byteLength: 10,
    sha256: 'a'.repeat(64),
    epsg: 26915,
    origin: { easting: 1000, northing: 2000 },
    bbox: { xmin: 1100, ymin: 2100, xmax: 3420, ymax: 4420 },
    localRect: { minEast: 100, minNorth: 100, maxEast: 2420, maxNorth: 2420 },
    compressionQuality: 75,
    width: 4000,
    height: 4000,
    metresPerPixel: 0.58,
  };

  it('accepts a consistent manifest', () => {
    expect(ImageryInsetManifestSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects a local rect that is not bbox minus origin', () => {
    const bad = { ...valid, localRect: { ...valid.localRect, minEast: 99 } };
    expect(ImageryInsetManifestSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects a compressionQuality that disagrees with the request params', () => {
    const bad = { ...valid, params: { compressionQuality: '60' } };
    expect(ImageryInsetManifestSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects metresPerPixel that disagrees with bbox and width, and an unknown key', () => {
    expect(ImageryInsetManifestSchema.safeParse({ ...valid, metresPerPixel: 1 }).success).toBe(
      false,
    );
    expect(ImageryInsetManifestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

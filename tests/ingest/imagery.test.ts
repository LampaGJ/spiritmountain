import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMAGE_WIDTH, checkExportExtent, jpegSize, runImagery } from '../../scripts/ingest/imagery';
import { ImageryManifestSchema } from '../../scripts/ingest/imagery-manifest-schema';
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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'imagery-'));
  mkdirSync(path.join(dataDir, 'raw'));
  copyFileSync('data/raw/manifest.json', path.join(dataDir, 'raw/manifest.json'));
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

describe('jpegSize', () => {
  it('reads width and height from the SOF marker', () => {
    expect(jpegSize(fakeJpeg(4000, 3879))).toEqual({ width: 4000, height: 3879 });
  });
  it('names the first bytes when the body is not a JPEG', () => {
    expect(() => jpegSize(new TextEncoder().encode('{"error":{"code":400}}'))).toThrow(
      /ImageryNotJpeg: first bytes 7b 22/,
    );
  });
});

describe('runImagery', () => {
  it('requests the terrain box at 4000 px, writes the jpg and a manifest whose sha256 matches', async () => {
    const dataDir = sandbox();
    const jpg = fakeJpeg(IMAGE_WIDTH, 3879);
    const { fetchImpl, urls } = respond(jpg);
    const m = await runImagery({ dataDir, fetchImpl, now: () => 0 });
    const q = new URL(urls[0] as string).searchParams;
    expect(q.get('bbox')).toBe('556530,5169870,563480,5176610');
    expect(q.get('size')).toBe('4000,3879');
    expect(q.get('bboxSR')).toBe('26915');
    expect(q.get('imageSR')).toBe('26915');
    expect(q.get('format')).toBe('jpg');
    expect(q.get('f')).toBe('image');
    const written = readFileSync(path.join(dataDir, 'raw/naip.jpg'));
    expect(sha256Hex(written)).toBe(m.sha256);
    expect(m.metresPerPixel).toBeCloseTo(1.7375, 6);
    const onDisk = ImageryManifestSchema.parse(
      JSON.parse(readFileSync(path.join(dataDir, 'raw/imagery-manifest.json'), 'utf8')),
    );
    expect(onDisk).toEqual(m);
  });

  it('refuses to overwrite without force (AlreadyPinned), and --force supersedes', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(fakeJpeg(IMAGE_WIDTH, 3879));
    await runImagery({ dataDir, fetchImpl });
    await expect(runImagery({ dataDir, fetchImpl })).rejects.toMatchObject({
      code: 'AlreadyPinned',
    });
    await expect(runImagery({ dataDir, fetchImpl, force: true })).resolves.toBeTruthy();
  });

  it('rejects a 200 JSON error body by content type and writes nothing', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(
      new TextEncoder().encode('{"error":{"code":400,"message":"bad size"}}'),
      'application/json',
    );
    await expect(runImagery({ dataDir, fetchImpl })).rejects.toThrow(
      /ImageryNotJpeg: content-type is "application\/json", body starts "\{"error"/,
    );
    expect(existsSync(path.join(dataDir, 'raw/naip.jpg'))).toBe(false);
  });

  it('rejects an image whose size is not the requested size', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(fakeJpeg(1000, 900));
    await expect(runImagery({ dataDir, fetchImpl })).rejects.toThrow(
      /ImageryBadSize: image is 1000x900, requested 4000x3879/,
    );
    expect(existsSync(path.join(dataDir, 'raw/imagery-manifest.json'))).toBe(false);
  });

  it('names a non-retryable HTTP status', async () => {
    const dataDir = sandbox();
    const { fetchImpl } = respond(new Uint8Array(), 'text/plain', 400);
    await expect(runImagery({ dataDir, fetchImpl })).rejects.toThrow(/ImageryHttpError: HTTP 400/);
  });
});

describe('returned-extent check (#75)', () => {
  const requested = { xmin: 556530, ymin: 5169870, xmax: 563480, ymax: 5176610 };
  /** The f=json body the service returned for the pinned request on 2026-10-08: x widened 0.12 m a side to square the pixels. */
  const echo = (extent: Partial<typeof requested> = {}, width = 4000, height = 3879) => ({
    href: 'https://example.invalid/out.jpg',
    width,
    height,
    extent: {
      xmin: 556529.8775457592,
      ymin: 5169870,
      xmax: 563480.1224542408,
      ymax: 5176610,
      ...extent,
      spatialReference: { wkid: 26915, latestWkid: 26915 },
    },
    scale: 0,
  });

  it('accepts the live echo (0.12 m is under half a pixel)', () => {
    expect(() => checkExportExtent(echo(), requested, 4000, 3879)).not.toThrow();
  });

  it('names the edge when the returned extent moves by more than half a pixel', () => {
    expect(() => checkExportExtent(echo({ ymax: 5176611 }), requested, 4000, 3879)).toThrow(
      /ImageryExtentMismatch: .*ymax/,
    );
  });

  it('refuses a returned size that differs from the request', () => {
    expect(() => checkExportExtent(echo({}, 4000, 3878), requested, 4000, 3879)).toThrow(
      /ImageryExtentMismatch: .*4000x3878/,
    );
  });

  it('asks f=json first with the same params and validates it, then fetches the image', async () => {
    const dataDir = sandbox();
    const urls: string[] = [];
    const jpg = fakeJpeg(IMAGE_WIDTH, 3879);
    const fetchImpl = (url: string) => {
      urls.push(url);
      const json = new URL(url).searchParams.get('f') === 'json';
      return Promise.resolve(
        json
          ? new Response(JSON.stringify(echo()), {
              headers: { 'content-type': 'application/json' },
            })
          : new Response(jpg as BodyInit, { headers: { 'content-type': 'image/jpeg' } }),
      );
    };
    await runImagery({ dataDir, fetchImpl, now: () => 0, checkExtent: true });
    expect(urls.map((u) => new URL(u).searchParams.get('f'))).toEqual(['json', 'image']);
    const a = new URL(urls[0] as string).searchParams;
    const b = new URL(urls[1] as string).searchParams;
    a.delete('f');
    b.delete('f');
    expect(a.toString()).toBe(b.toString());
  });

  it('writes nothing when the echo disagrees', async () => {
    const dataDir = sandbox();
    const fetchImpl = (url: string) =>
      Promise.resolve(
        new URL(url).searchParams.get('f') === 'json'
          ? new Response(JSON.stringify(echo({ xmin: 556520 })), {
              headers: { 'content-type': 'application/json' },
            })
          : new Response(fakeJpeg(IMAGE_WIDTH, 3879) as BodyInit, {
              headers: { 'content-type': 'image/jpeg' },
            }),
      );
    await expect(runImagery({ dataDir, fetchImpl, checkExtent: true })).rejects.toThrow(
      /ImageryExtentMismatch: .*xmin/,
    );
    expect(existsSync(path.join(dataDir, 'raw/naip.jpg'))).toBe(false);
  });

  it('refuses an echo that is not the documented shape', async () => {
    const dataDir = sandbox();
    const fetchImpl = () =>
      Promise.resolve(
        new Response('{"error":{"code":400}}', { headers: { 'content-type': 'application/json' } }),
      );
    await expect(runImagery({ dataDir, fetchImpl, checkExtent: true })).rejects.toThrow(
      /ImageryExtentMismatch: .*not an exportImage echo/,
    );
  });
});

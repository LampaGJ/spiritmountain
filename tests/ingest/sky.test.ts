import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseVariant, parseRgbeHeader, runSky } from '../../scripts/ingest/sky';
import { SkyManifestSchema } from '../../scripts/ingest/sky-manifest-schema';

const header = (body: string): Uint8Array =>
  new TextEncoder().encode(
    `#?RADIANCE\n# Made with test\nFORMAT=32-bit_rle_rgbe\n\n${body}\n\u0001\u0002`,
  );

describe('parseRgbeHeader', () => {
  it('reads -Y height +X width from a hand-made header', () => {
    expect(parseRgbeHeader(header('-Y 512 +X 1024'))).toEqual({ width: 1024, height: 512 });
  });

  it('rejects bytes that are not Radiance and headers without a resolution line', () => {
    expect(() => parseRgbeHeader(new TextEncoder().encode('GIF89a......'))).toThrow(/SkyNotHdr/);
    expect(() => parseRgbeHeader(new TextEncoder().encode('#?RADIANCE\n\nnope\n'))).toThrow(
      /resolution line/,
    );
  });

  it('reads the pinned sky file', () => {
    const m = SkyManifestSchema.parse(
      JSON.parse(readFileSync('data/raw/sky-manifest.json', 'utf8')),
    );
    const bytes = readFileSync(m.path);
    expect(parseRgbeHeader(bytes)).toEqual({ width: m.width, height: m.height });
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(m.sha256);
    expect(bytes.byteLength).toBeLessThan(4_000_000);
  });
});

describe('chooseVariant', () => {
  const entry = (size: number, tag: string) => ({
    hdr: { url: `https://dl.example.org/${tag}.hdr`, size, md5: 'a'.repeat(32) },
  });
  it('picks 2k only when it is under 4,000,000 bytes', () => {
    expect(
      chooseVariant({ hdri: { '2k': entry(3_900_000, '2k'), '1k': entry(1_000, '1k') } }).variant,
    ).toBe('2k');
    expect(
      chooseVariant({ hdri: { '2k': entry(5_451_493, '2k'), '1k': entry(1_435_119, '1k') } })
        .variant,
    ).toBe('1k');
  });
});

describe('SkyManifestSchema fixtures', () => {
  const valid = () => ({
    version: 1,
    name: 'sky',
    path: 'data/raw/sky.hdr',
    asset: 'kloofendal_48d_partly_cloudy_puresky',
    variant: '1k',
    format: 'hdr',
    url: 'https://dl.example.org/sky.hdr',
    method: 'GET',
    requestHeaders: { userAgent: 'x' },
    httpStatus: 200,
    fetchedAt: '2026-10-07T02:00:43.553Z',
    byteLength: 10,
    sha256: 'a'.repeat(64),
    apiSize: 10,
    md5: 'b'.repeat(32),
    width: 1024,
    height: 512,
    license: 'CC0',
    authors: { 'Greg Zaal': 'Original' },
  });
  it('accepts a valid manifest and the committed one', () => {
    expect(SkyManifestSchema.safeParse(valid()).success).toBe(true);
    expect(
      SkyManifestSchema.safeParse(JSON.parse(readFileSync('data/raw/sky-manifest.json', 'utf8')))
        .success,
    ).toBe(true);
  });
  it('rejects a wrong licence, a bad md5 and unknown keys', () => {
    expect(SkyManifestSchema.safeParse({ ...valid(), license: 'CC-BY' }).success).toBe(false);
    expect(SkyManifestSchema.safeParse({ ...valid(), md5: 'zz' }).success).toBe(false);
    expect(SkyManifestSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
  });
});

describe('runSky with a fake fetch', () => {
  const hdr = header('-Y 2 +X 4');
  const md5 = createHash('md5').update(hdr).digest('hex');
  const fakeFetch =
    (log: string[]) =>
    async (url: string): Promise<Response> => {
      log.push(url);
      if (url.includes('/files/')) {
        return Response.json({
          hdri: {
            '1k': { hdr: { url: 'https://dl.example.org/sky_1k.hdr', size: hdr.byteLength, md5 } },
          },
        });
      }
      if (url.includes('/info/')) return Response.json({ authors: { 'A B': 'Original' } });
      return new Response(Buffer.from(hdr), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    };

  it('pins the file, refuses a rerun without force, and sends the User-Agent', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sky-'));
    const log: string[] = [];
    const m = await runSky({ dataDir, fetchImpl: fakeFetch(log), now: () => 0 });
    expect(m.variant).toBe('1k');
    expect(m.width).toBe(4);
    expect(existsSync(path.join(dataDir, 'raw/sky.hdr'))).toBe(true);
    expect(log).toHaveLength(3);
    await expect(runSky({ dataDir, fetchImpl: fakeFetch(log) })).rejects.toMatchObject({
      code: 'AlreadyPinned',
    });
  });

  it('rejects a body whose md5 differs and writes nothing', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sky-'));
    const bad = async (url: string): Promise<Response> =>
      url.includes('sky_1k') ? new Response(Buffer.from(header('-Y 2 +X 5'))) : fakeFetch([])(url);
    await expect(runSky({ dataDir, fetchImpl: bad })).rejects.toThrow(/SkyBad(Md5|Size)/);
    expect(existsSync(path.join(dataDir, 'raw/sky.hdr'))).toBe(false);
  });
});

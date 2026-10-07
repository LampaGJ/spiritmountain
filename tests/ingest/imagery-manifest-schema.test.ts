import { describe, expect, it } from 'vitest';
import {
  ImageryManifestSchema,
  imageHeightFor,
} from '../../scripts/ingest/imagery-manifest-schema';

const BBOX = { xmin: 556530, ymin: 5169870, xmax: 563480, ymax: 5176610 };

const valid = {
  version: 1,
  name: 'naip',
  path: 'data/raw/naip.jpg',
  url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage',
  method: 'GET',
  params: { bbox: '556530,5169870,563480,5176610', f: 'image' },
  requestHeaders: { userAgent: 'spiritmountain-poc/0.1' },
  httpStatus: 200,
  contentType: 'image/jpeg',
  fetchedAt: '2026-10-06T20:00:00.000Z',
  byteLength: 1234,
  sha256: 'a'.repeat(64),
  epsg: 26915,
  bbox: BBOX,
  width: 4000,
  height: 3879,
  metresPerPixel: 1.7375,
};

describe('imageHeightFor', () => {
  it('keeps the box aspect: round(width * dy / dx)', () => {
    expect(imageHeightFor(BBOX, 4000)).toBe(3879);
    expect(imageHeightFor({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }, 4000)).toBe(2000);
  });
});

describe('ImageryManifestSchema', () => {
  it('accepts a valid entry', () => {
    expect(ImageryManifestSchema.parse(valid).width).toBe(4000);
  });
  it('rejects a height that breaks the box aspect, naming the path', () => {
    const r = ImageryManifestSchema.safeParse({ ...valid, height: 3880 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain('height');
  });
  it('rejects a non-jpeg content type', () => {
    expect(ImageryManifestSchema.safeParse({ ...valid, contentType: 'image/png' }).success).toBe(
      false,
    );
  });
  it('rejects a metresPerPixel that disagrees with bbox and width', () => {
    expect(ImageryManifestSchema.safeParse({ ...valid, metresPerPixel: 1 }).success).toBe(false);
  });
  it('rejects an unknown key (strict) and a bad sha256', () => {
    expect(ImageryManifestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(ImageryManifestSchema.safeParse({ ...valid, sha256: 'xyz' }).success).toBe(false);
  });
  it('rejects an inverted bbox', () => {
    expect(
      ImageryManifestSchema.safeParse({ ...valid, bbox: { ...BBOX, xmax: BBOX.xmin } }).success,
    ).toBe(false);
  });
});

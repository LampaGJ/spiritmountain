import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanopySampler, loadCanopy } from '../../src/data/load-canopy';
import { CanopyHeaderSchema, type CanopyHeader } from '../../src/schema/canopy';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function headerFor(bytes: Uint8Array, width: number, height: number): CanopyHeader {
  const source = { path: 'data/x', sha256: 'a'.repeat(64) };
  return CanopyHeaderSchema.parse({
    version: 1,
    width,
    height,
    originX: 100,
    originY: 200,
    originCorner: 'top-left-of-top-left-cell',
    cellSizeM: 20,
    rowOrder: 'north-to-south',
    columnOrder: 'west-to-east',
    dtype: 'uint8',
    scaleM: 0.2,
    maxM: 40,
    reduction: 'block-max',
    byteLength: width * height,
    u8Sha256: sha(bytes),
    sources: { surfaceHeader: source, surface: source, terrainHeader: source, terrain: source },
  });
}

// 2 x 2 cells: top row 0 m and 10 m, bottom row 20 m and 30 m (bytes 0, 50, 100, 150).
const BYTES = new Uint8Array([0, 50, 100, 150]);

describe('createCanopySampler', () => {
  const sample = createCanopySampler(headerFor(BYTES, 2, 2), BYTES);

  it('returns the cell value at a cell centre', () => {
    expect(sample(110, 190)).toBeCloseTo(0, 6);
    expect(sample(130, 190)).toBeCloseTo(10, 6);
    expect(sample(110, 170)).toBeCloseTo(20, 6);
    expect(sample(130, 170)).toBeCloseTo(30, 6);
  });

  it('interpolates bilinearly between cell centres', () => {
    expect(sample(120, 190)).toBeCloseTo(5, 6);
    expect(sample(120, 180)).toBeCloseTo(15, 6);
  });

  it('holds the edge value between the grid edge and the nearest centre', () => {
    expect(sample(100, 200)).toBeCloseTo(0, 6);
    expect(sample(140, 160)).toBeCloseTo(30, 6);
  });

  it('is NaN outside the grid rectangle', () => {
    expect(sample(99, 190)).toBeNaN();
    expect(sample(141, 190)).toBeNaN();
    expect(sample(110, 201)).toBeNaN();
    expect(sample(110, 159)).toBeNaN();
  });
});

describe('loadCanopy', () => {
  afterEach(() => vi.restoreAllMocks());

  const respond = (header: unknown, bytes: Uint8Array): typeof fetch =>
    ((url: string) =>
      Promise.resolve(
        url.endsWith('.json')
          ? { ok: true, status: 200, json: () => Promise.resolve(header) }
          : { ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.slice().buffer) },
      )) as unknown as typeof fetch;
  const urls = { headerUrl: '/canopy.json', binUrl: '/canopy.u8' };

  it('loads a sampler through the header schema and the sha256 check', async () => {
    const sample = await loadCanopy({ ...urls, fetchImpl: respond(headerFor(BYTES, 2, 2), BYTES) });
    expect(sample?.(130, 190)).toBeCloseTo(10, 6);
  });

  it('logs one console.info and resolves null when the files are not in the build', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await loadCanopy({ headerUrl: undefined, binUrl: undefined })).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('resolves null with a named error for a renamed header field', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { width, ...rest } = headerFor(BYTES, 2, 2);
    void width;
    expect(await loadCanopy({ ...urls, fetchImpl: respond({ ...rest, wide: 2 }, BYTES) })).toBeNull();
    expect(String(error.mock.calls[0]?.[1])).toContain('width');
  });

  it('resolves null for a truncated body and for a wrong hash', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = headerFor(BYTES, 2, 2);
    expect(await loadCanopy({ ...urls, fetchImpl: respond(h, BYTES.slice(0, 3)) })).toBeNull();
    expect(await loadCanopy({ ...urls, fetchImpl: respond(h, new Uint8Array([9, 9, 9, 9])) })).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

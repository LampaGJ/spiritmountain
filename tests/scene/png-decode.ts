import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, row-major, row 0 at the top. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Minimal PNG reader for the tiles gen-patterns.mjs writes: 8-bit RGBA, non-interlaced.
 * Anything else throws, so a changed encoder cannot silently produce wrong pixels.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes);
  if (!SIGNATURE.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [bitDepth, colourType, , , interlace] = [
        data[8],
        data[9],
        data[10],
        data[11],
        data[12],
      ];
      if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG: depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[line + x] as number;
      const left = x >= 4 ? (out[y * stride + x - 4] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const upLeft = y > 0 && x >= 4 ? (out[(y - 1) * stride + x - 4] as number) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = cur;
          break;
        case 1:
          value = cur + left;
          break;
        case 2:
          value = cur + up;
          break;
        case 3:
          value = cur + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, rgba: out };
}

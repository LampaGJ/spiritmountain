// @manipulation reduces: prints haze-band statistics of the pinned sky HDR. Read-only, writes nothing.
// Usage: node scripts/measure-sky-haze.mjs [path-to-hdr]
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'data/raw/sky.hdr';
const buf = readFileSync(path);
let pos = 0;
const line = () => {
  let s = '';
  while (buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
  pos++;
  return s;
};
if (!line().startsWith('#?')) throw new Error('not a Radiance HDR');
while (line() !== '') {
  /* header */
}
const dim = /^-Y (\d+) \+X (\d+)$/.exec(line());
if (!dim) throw new Error('unsupported resolution line');
const height = Number(dim[1]);
const width = Number(dim[2]);
const pixels = new Float32Array(width * height * 3);
const scan = new Uint8Array(width * 4);
for (let y = 0; y < height; y++) {
  if (buf[pos] !== 2 || buf[pos + 1] !== 2 || ((buf[pos + 2] << 8) | buf[pos + 3]) !== width)
    throw new Error('expected new-style RLE scanlines');
  pos += 4;
  for (let c = 0; c < 4; c++) {
    let x = 0;
    while (x < width) {
      let n = buf[pos++];
      if (n > 128) {
        n -= 128;
        const v = buf[pos++];
        while (n-- > 0) scan[4 * x++ + c] = v;
      } else {
        while (n-- > 0) scan[4 * x++ + c] = buf[pos++];
      }
    }
  }
  for (let x = 0; x < width; x++) {
    const e = scan[4 * x + 3];
    const f = e === 0 ? 0 : 2 ** (e - 136);
    for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = scan[4 * x + c] * f;
  }
}

/** Mean linear RGB over rows whose centre elevation lies in [lo, hi) degrees. */
function band(lo, hi) {
  const sum = [0, 0, 0];
  let rows = 0;
  for (let y = 0; y < height; y++) {
    const elev = 90 - ((y + 0.5) * 180) / height;
    if (elev < lo || elev >= hi) continue;
    rows++;
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) sum[c] += pixels[(y * width + x) * 3 + c];
  }
  const m = sum.map((s) => s / (rows * width));
  const lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  const sat = (Math.max(...m) - Math.min(...m)) / Math.max(...m);
  return {
    lo,
    hi,
    rows,
    rgb: m.map((v) => +v.toFixed(4)),
    lum: +lum.toFixed(4),
    sat: +sat.toFixed(3),
  };
}

const bands = [band(0, 2), band(2, 5), band(5, 15), band(29, 31), band(0, 5)];
const ref = bands[3].lum;
for (const b of bands)
  console.log(JSON.stringify({ ...b, lumRatioVs30: +(b.lum / ref).toFixed(3) }));

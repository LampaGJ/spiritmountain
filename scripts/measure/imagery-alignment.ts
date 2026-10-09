/**
 * @displayName Imagery alignment measurement
 * @strategicPurpose Measures how far the photo the scene drapes sits from the OSM features drawn on it, so a mapping
 *   bug (#75) or a datum error (#77) shows up as a number with a standard error instead of an impression.
 * @tacticalObjective Read-only. Parses data/terrain.json, data/raw/imagery-inset-manifest.json,
 *   data/buildings.geojson and data/areas.geojson at the boundary, decodes the pinned data/raw/naip.jpg and
 *   data/raw/naip-inset.jpg, and prints: per-building photo-minus-OSM offsets in the base photo and the inset (roof-edge
 *   matching), their mean, spread and similarity fit; a dense base-versus-inset registration; and lift-corridor
 *   cross-offsets. Writes no file; heartbeats go to reports/.progress only (gitignored).
 *
 * Usage:
 *   npx tsx scripts/measure/imagery-alignment.ts                    print the report
 *   npx tsx scripts/measure/imagery-alignment.ts --json > a.json    print the raw result as JSON instead
 *   npx tsx scripts/measure/imagery-alignment.ts --compare a.json   print the report, then a before (a.json) and
 *                                                                   after (now) pairing by feature id
 *
 * Method (promoted from the #75 probe; see the #75 measurement comment):
 * - Photo positions go through the scene's own maths. The base photo uses the `uv` attribute of the geometry
 *   createTerrainMesh draws (src/scene/terrain.ts), with flipY and pixel i spanning [i, i + 1]. The inset uses the
 *   rect-relative uv of src/scene/inset.ts with the manifest localRect.
 * - A building's offset is the outline shift (0.25 px grid, +/-12 m) that maximises the mean luminance step across the
 *   outline, refined by a parabola. It is rejected on the search edge, at a peak ratio under 1.15, or when a second
 *   peak 3 m or more away reaches 0.98 of the best (the cut behind the #77 baseline).
 * - Dense registration: 49 patches, 150 m square, NCC of the base photo against the 3 x 3 box-filtered inset.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decode } from 'jpeg-js';
import { z } from 'zod';
import { ImageryInsetManifestSchema } from '../ingest/imagery-inset-manifest-schema';
import { AreaFeatureCollectionSchema } from '../../src/schema/area';
import { BuildingFeatureCollectionSchema } from '../../src/schema/building';
import { TerrainHeaderSchema } from '../../src/schema/terrain';
import { createMeshSurface } from '../../src/scene/heightfield';
import { createTerrainMesh } from '../../src/scene/terrain';

/** Upper Chalet (summit) and Grand Avenue Chalet (base): always measured, in both photos. */
const ANCHOR_IDS = ['way/146915066', 'way/1150220697'] as const;
const PEAK_MIN = 1.15;
const SECOND_MAX = 0.98;
const SEARCH_M = 12;

function parseFile<T>(path: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success)
    throw new Error(`${path} failed its schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

interface Img {
  w: number;
  h: number;
  lum: Float32Array;
}

function loadLuminance(path: string): Img {
  const d = decode(readFileSync(path), { useTArray: true, maxMemoryUsageInMB: 2048 });
  const lum = new Float32Array(d.width * d.height);
  for (let i = 0; i < lum.length; i += 1) {
    lum[i] = 0.299 * d.data[i * 4]! + 0.587 * d.data[i * 4 + 1]! + 0.114 * d.data[i * 4 + 2]!;
  }
  return { w: d.width, h: d.height, lum };
}

/** Bilinear sample at continuous pixel coordinates (pixel centre at i + 0.5), as GL LINEAR filtering does. */
function sample(img: Img, x: number, y: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const ix = Math.max(0, Math.min(img.w - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(img.h - 2, Math.floor(fy)));
  const ax = fx - ix;
  const ay = fy - iy;
  const L = img.lum;
  const w = img.w;
  return (
    (L[iy * w + ix]! * (1 - ax) + L[iy * w + ix + 1]! * ax) * (1 - ay) +
    (L[(iy + 1) * w + ix]! * (1 - ax) + L[(iy + 1) * w + ix + 1]! * ax) * ay
  );
}

interface Mapping {
  name: 'base' | 'inset';
  img: Img;
  mPerPx: number;
  toPx(e: number, n: number): [number, number];
  fromPx(x: number, y: number): [number, number];
}

type Ring = ReadonlyArray<readonly number[]>;

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i += 1)
    a += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  return Math.abs(a / 2);
}

function centroid(ring: Ring): [number, number] {
  let x = 0;
  let y = 0;
  const k = ring.length - 1;
  for (let i = 0; i < k; i += 1) {
    x += ring[i]![0]!;
    y += ring[i]![1]!;
  }
  return [x / k, y / k];
}

/** Shift (pixels) of the projected outline that maximises the luminance step across it (the roof edge). */
function alignOutline(m: Mapping, ring: Ring, searchM: number) {
  const samples: { x: number; y: number; nx: number; ny: number }[] = [];
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [ax, ay] = m.toPx(ring[i]![0]!, ring[i]![1]!);
    const [bx, by] = m.toPx(ring[i + 1]![0]!, ring[i + 1]![1]!);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    const steps = Math.max(1, Math.ceil(len / 0.5));
    for (let s = 0; s < steps; s += 1) {
      const t = (s + 0.5) / steps;
      if (t * len < 1 || (1 - t) * len < 1) continue; // corners mix two edge directions
      samples.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx: -ty, ny: tx });
    }
  }
  const step = 0.25;
  const n = Math.round(searchM / m.mPerPx / step);
  const side = 2 * n + 1;
  const grid = new Float64Array(side * side);
  let best = -Infinity;
  let bi = 0;
  let bj = 0;
  let sum = 0;
  for (let j = -n; j <= n; j += 1) {
    for (let i = -n; i <= n; i += 1) {
      const dx = i * step;
      const dy = j * step;
      let s = 0;
      for (const p of samples) {
        s += Math.abs(
          sample(m.img, p.x + dx + p.nx, p.y + dy + p.ny) -
            sample(m.img, p.x + dx - p.nx, p.y + dy - p.ny),
        );
      }
      s /= samples.length;
      grid[(j + n) * side + (i + n)] = s;
      sum += s;
      if (s > best) {
        best = s;
        bi = i;
        bj = j;
      }
    }
  }
  const onEdge = Math.abs(bi) === n || Math.abs(bj) === n;
  const at = (i: number, j: number) => grid[(j + n) * side + (i + n)]!;
  let fx = 0;
  let fy = 0;
  if (!onEdge) {
    const c = at(bi, bj);
    const d = at(bi - 1, bj) - 2 * c + at(bi + 1, bj);
    if (d < 0) fx = (0.5 * (at(bi - 1, bj) - at(bi + 1, bj))) / d;
    const d2 = at(bi, bj - 1) - 2 * c + at(bi, bj + 1);
    if (d2 < 0) fy = (0.5 * (at(bi, bj - 1) - at(bi, bj + 1))) / d2;
  }
  const minSep = 3 / m.mPerPx / step;
  let second = -Infinity;
  for (let j = -n; j <= n; j += 1)
    for (let i = -n; i <= n; i += 1) {
      if (Math.hypot(i - bi, j - bj) < minSep) continue;
      second = Math.max(second, at(i, j));
    }
  return {
    dxPx: (bi + fx) * step,
    dyPx: (bj + fy) * step,
    peakRatio: best / (sum / (side * side)),
    secondRatio: second / best,
    onEdge,
  };
}

const FeatureResultSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  areaM2: z.number(),
  osmEast: z.number(),
  osmNorth: z.number(),
  photoEast: z.number(),
  photoNorth: z.number(),
  dE: z.number(),
  dN: z.number(),
  peakRatio: z.number(),
  secondRatio: z.number(),
  onEdge: z.boolean(),
});
type FeatureResult = z.infer<typeof FeatureResultSchema>;

const DenseResultSchema = z.strictObject({
  east: z.number(),
  north: z.number(),
  baseMinusInsetE: z.number(),
  baseMinusInsetN: z.number(),
  ncc: z.number(),
});
type DenseResult = z.infer<typeof DenseResultSchema>;

const LiftResultSchema = z.strictObject({
  name: z.string().nullable(),
  crossOffsetM: z.number(),
  corridorWidthM: z.number(),
  contrast: z.number(),
});
type LiftResult = z.infer<typeof LiftResultSchema>;

/**
 * @displayName Imagery alignment result
 * @strategicPurpose The machine form of one measurement run, so a later run can pair against it by feature id.
 * @tacticalObjective Validates the base and inset building offsets, the dense patches and the lift corridors that
 *   --json prints and --compare reads back.
 */
export const AlignmentResultSchema = z.strictObject({
  base: z.array(FeatureResultSchema).min(1),
  inset: z.array(FeatureResultSchema).min(1),
  dense: z.array(DenseResultSchema).min(1),
  lifts: z.array(LiftResultSchema),
});
export type AlignmentResult = z.infer<typeof AlignmentResultSchema>;

type Tick = (done: number, extra?: Record<string, unknown>) => void;

/** Runs the whole measurement against the repository data under `root` (default: the working directory). */
export function measureAlignment(root = '.', tick: Tick = () => undefined): AlignmentResult {
  const header = parseFile(`${root}/data/terrain.json`, TerrainHeaderSchema);
  const manifest = parseFile(
    `${root}/data/raw/imagery-inset-manifest.json`,
    ImageryInsetManifestSchema,
  );
  const buildings = parseFile(`${root}/data/buildings.geojson`, BuildingFeatureCollectionSchema);
  const areas = parseFile(`${root}/data/areas.geojson`, AreaFeatureCollectionSchema);

  // The scene's own base-photo uv: the geometry createTerrainMesh draws. Heights do not affect uv.
  const surface = createMeshSurface({
    cols: header.width,
    rows: header.height,
    originEast: header.originX + 0.5 * header.cellSizeX,
    originNorth: header.originY - 0.5 * header.cellSizeY,
    cellSizeEast: header.cellSizeX,
    cellSizeNorth: header.cellSizeY,
    data: new Float32Array(header.width * header.height),
  });
  const geom = createTerrainMesh(surface).geometry;
  const pos = geom.getAttribute('position');
  const uv = geom.getAttribute('uv');
  const last = pos.count - 1;
  const e0 = pos.getX(0);
  const n0 = -pos.getZ(0);
  const e1 = pos.getX(last);
  const n1 = -pos.getZ(last);
  const u0 = uv.getX(0);
  const v0 = uv.getY(0);
  const u1 = uv.getX(last);
  const v1 = uv.getY(last);
  for (const k of [Math.floor(pos.count / 2) + 7, Math.floor(pos.count / 3), pos.count - 999]) {
    const uP = u0 + ((pos.getX(k) - e0) / (e1 - e0)) * (u1 - u0);
    const vP = v0 + ((-pos.getZ(k) - n0) / (n1 - n0)) * (v1 - v0);
    if (Math.abs(uP - uv.getX(k)) > 1e-6 || Math.abs(vP - uv.getY(k)) > 1e-6)
      throw new Error(
        'terrain uv is not affine in position; the base mapping below would be wrong',
      );
  }

  const base = loadLuminance(`${root}/data/raw/naip.jpg`);
  const inset = loadLuminance(`${root}/data/raw/naip-inset.jpg`);
  const baseMap: Mapping = {
    name: 'base',
    img: base,
    mPerPx: (e1 - e0) / ((u1 - u0) * base.w),
    toPx(e, n) {
      const u = u0 + ((e - e0) / (e1 - e0)) * (u1 - u0);
      const v = v0 + ((n - n0) / (n1 - n0)) * (v1 - v0);
      return [u * base.w, (1 - v) * base.h];
    },
    fromPx(x, y) {
      const u = x / base.w;
      const v = 1 - y / base.h;
      return [e0 + ((u - u0) / (u1 - u0)) * (e1 - e0), n0 + ((v - v0) / (v1 - v0)) * (n1 - n0)];
    },
  };
  const r = manifest.localRect;
  const insetMap: Mapping = {
    name: 'inset',
    img: inset,
    mPerPx: (r.maxEast - r.minEast) / inset.w,
    toPx(e, n) {
      const u = (e - r.minEast) / (r.maxEast - r.minEast);
      const v = (n - r.minNorth) / (r.maxNorth - r.minNorth);
      return [u * inset.w, (1 - v) * inset.h];
    },
    fromPx(x, y) {
      const u = x / inset.w;
      const v = 1 - y / inset.h;
      return [r.minEast + u * (r.maxEast - r.minEast), r.minNorth + v * (r.maxNorth - r.minNorth)];
    },
  };

  interface Poly {
    id: string;
    name: string | null;
    ring: Ring;
    area: number;
    centre: [number, number];
  }
  const polys: Poly[] = buildings.features.map((f) => {
    const ring = f.geometry.coordinates[0]!;
    return {
      id: f.properties.id,
      name: f.properties.name,
      ring,
      area: ringArea(ring),
      centre: centroid(ring),
    };
  });
  const byId = new Map(polys.map((p) => [p.id, p]));
  const anchors = ANCHOR_IDS.map((id) => {
    const p = byId.get(id);
    if (p === undefined)
      throw new Error(`anchor building ${id} is missing from data/buildings.geojson`);
    return p;
  });

  const pickGrid = (
    box: { minE: number; maxE: number; minN: number; maxN: number },
    cells: number,
    minArea: number,
  ) => {
    const out: Poly[] = [];
    const cw = (box.maxE - box.minE) / cells;
    const ch = (box.maxN - box.minN) / cells;
    for (let j = 0; j < cells; j += 1)
      for (let i = 0; i < cells; i += 1) {
        const cand = polys
          .filter(({ centre: [e, n], area }) => {
            return (
              area >= minArea &&
              e >= box.minE + i * cw &&
              e < box.minE + (i + 1) * cw &&
              n >= box.minN + j * ch &&
              n < box.minN + (j + 1) * ch
            );
          })
          .sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (cand[0] && !anchors.includes(cand[0])) out.push(cand[0]);
      }
    return out;
  };
  const margin = 40;
  const baseSet = [
    ...anchors,
    ...pickGrid(
      {
        minE: Math.min(e0, e1) + margin,
        maxE: Math.max(e0, e1) - margin,
        minN: Math.min(n0, n1) + margin,
        maxN: Math.max(n0, n1) - margin,
      },
      6,
      150,
    ),
  ];
  const insetSet = [
    ...anchors,
    ...pickGrid(
      { minE: r.minEast + 80, maxE: r.maxEast - 80, minN: r.minNorth + 80, maxN: r.maxNorth - 80 },
      4,
      100,
    ),
  ];

  let done = 0;
  const measure = (m: Mapping, f: Poly): FeatureResult => {
    const a = alignOutline(m, f.ring, SEARCH_M);
    done += 1;
    tick(done, { layer: m.name, id: f.id });
    const [px, py] = m.toPx(f.centre[0], f.centre[1]);
    const [pe, pn] = m.fromPx(px + a.dxPx, py + a.dyPx);
    return {
      id: f.id,
      name: f.name,
      areaM2: f.area,
      osmEast: f.centre[0],
      osmNorth: f.centre[1],
      photoEast: pe,
      photoNorth: pn,
      dE: pe - f.centre[0],
      dN: pn - f.centre[1],
      peakRatio: a.peakRatio,
      secondRatio: a.secondRatio,
      onEdge: a.onEdge,
    };
  };
  const baseResults = baseSet.map((f) => measure(baseMap, f));
  const insetResults = insetSet.map((f) => measure(insetMap, f));

  // Lift corridors in the inset: the cross-line offset of the cleared corridor from the OSM line (+ = left).
  const resample = (c: ReadonlyArray<readonly number[]>, s: number) => {
    const seg: number[] = [];
    let total = 0;
    for (let i = 0; i < c.length - 1; i += 1) {
      const l = Math.hypot(c[i + 1]![0]! - c[i]![0]!, c[i + 1]![1]! - c[i]![1]!);
      seg.push(l);
      total += l;
    }
    let d = s * total;
    for (let i = 0; i < seg.length; i += 1) {
      if (d <= seg[i]! || i === seg.length - 1) {
        const te = (c[i + 1]![0]! - c[i]![0]!) / seg[i]!;
        const tn = (c[i + 1]![1]! - c[i]![1]!) / seg[i]!;
        return { e: c[i]![0]! + te * d, n: c[i]![1]! + tn * d, te, tn };
      }
      d -= seg[i]!;
    }
    throw new Error('resample: empty line');
  };
  const lifts: LiftResult[] = [];
  for (const f of areas.features) {
    if (f.properties.kind !== 'lift' || f.geometry.type !== 'LineString') continue;
    const c = f.geometry.coordinates;
    const offs: number[] = [];
    for (let k = 0; k <= 240; k += 1) offs.push(-30 + k * 0.25);
    const prof = offs.map(() => [] as number[]);
    for (let k = 15; k <= 85; k += 1) {
      const p = resample(c, k / 100);
      offs.forEach((o, i) => {
        const [x, y] = insetMap.toPx(p.e - p.tn * o, p.n + p.te * o);
        prof[i]!.push(sample(inset, x, y));
      });
    }
    const med = prof.map((v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!);
    const meanIn = (lo: number, hi: number) => {
      let s = 0;
      let k = 0;
      offs.forEach((o, i) => {
        if (o >= lo && o < hi) {
          s += med[i]!;
          k += 1;
        }
      });
      return s / k;
    };
    let best = { score: -Infinity, centre: 0, width: 0 };
    for (let w = 4; w <= 30; w += 0.5)
      for (let cc = -12; cc <= 12; cc += 0.25) {
        if (cc - w < -30 || cc + w > 30) continue;
        const score =
          meanIn(cc - w / 2, cc + w / 2) -
          0.5 * (meanIn(cc - w, cc - w / 2) + meanIn(cc + w / 2, cc + w));
        if (score > best.score) best = { score, centre: cc, width: w };
      }
    lifts.push({
      name: f.properties.name,
      crossOffsetM: best.centre,
      corridorWidthM: best.width,
      contrast: best.score,
    });
  }

  // Dense base-versus-inset registration, both through the scene maths. The inset is box-filtered to the base
  // pixel footprint (3 x 3 inset pixels per base pixel) so NCC compares like with like.
  const insetBlur: Img = (() => {
    const w = inset.w;
    const h = inset.h;
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y += 1)
      for (let x = 1; x < w - 1; x += 1) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) s += inset.lum[(y + dy) * w + x + dx]!;
        out[y * w + x] = s / 9;
      }
    return { w, h, lum: out };
  })();
  const ncc = (a: Float64Array, b: Float64Array): number => {
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < a.length; i += 1) {
      ma += a[i]!;
      mb += b[i]!;
    }
    ma /= a.length;
    mb /= b.length;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < a.length; i += 1) {
      const da = a[i]! - ma;
      const db = b[i]! - mb;
      sab += da * db;
      saa += da * da;
      sbb += db * db;
    }
    return sab / Math.sqrt(saa * sbb);
  };
  const dense: DenseResult[] = [];
  for (let gn = 0; gn < 7; gn += 1)
    for (let ge = 0; ge < 7; ge += 1) {
      const ce = r.minEast + 200 + (ge * (r.maxEast - r.minEast - 400)) / 6;
      const cn = r.minNorth + 200 + (gn * (r.maxNorth - r.minNorth - 400)) / 6;
      const [cx, cy] = baseMap.toPx(ce, cn);
      const hp = Math.round(75 / baseMap.mPerPx);
      const pts: [number, number][] = [];
      const a: number[] = [];
      for (let j = -hp; j <= hp; j += 1)
        for (let i = -hp; i <= hp; i += 1) {
          const x = Math.floor(cx) + i + 0.5;
          const y = Math.floor(cy) + j + 0.5;
          pts.push(baseMap.fromPx(x, y));
          a.push(sample(base, x, y));
        }
      const A = Float64Array.from(a);
      const B = new Float64Array(A.length);
      const score = (de: number, dn: number) => {
        pts.forEach(([e, n], k) => {
          const [x, y] = insetMap.toPx(e + de, n + dn);
          B[k] = sample(insetBlur, x, y);
        });
        return ncc(A, B);
      };
      let best = { s: -Infinity, de: 0, dn: 0 };
      for (let kn = -16; kn <= 16; kn += 1)
        for (let ke = -16; ke <= 16; ke += 1) {
          const s = score(ke * 0.5, kn * 0.5);
          if (s > best.s) best = { s, de: ke * 0.5, dn: kn * 0.5 };
        }
      const coarse = best;
      for (let kn = -5; kn <= 5; kn += 1)
        for (let ke = -5; ke <= 5; ke += 1) {
          const de = coarse.de + ke * 0.1;
          const dn = coarse.dn + kn * 0.1;
          const s = score(de, dn);
          if (s > best.s) best = { s, de, dn };
        }
      // The inset shift that matches is (inset minus base); the displayed base position minus inset is its negative.
      dense.push({
        east: ce,
        north: cn,
        baseMinusInsetE: -best.de,
        baseMinusInsetN: -best.dn,
        ncc: best.s,
      });
      tick(done + dense.length, { phase: 'dense', patches: dense.length });
    }

  return AlignmentResultSchema.parse({ base: baseResults, inset: insetResults, dense, lifts });
}

const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0);
const mean = (a: readonly number[]) => sum(a) / a.length;
const sd = (a: readonly number[]) => {
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
};
const fmt = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const kept = (f: FeatureResult) =>
  !f.onEdge && f.peakRatio >= PEAK_MIN && f.secondRatio < SECOND_MAX;

/** Least squares by normal equations with partial pivoting (four unknowns). */
function solve(A: number[][], b: number[]): number[] {
  const n = A[0]!.length;
  const M = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) =>
      sum(A.map((row, k) => row[i]! * (j < n ? row[j]! : b[k]!))),
    ),
  );
  for (let i = 0; i < n; i += 1) {
    let p = i;
    for (let k = i + 1; k < n; k += 1) if (Math.abs(M[k]![i]!) > Math.abs(M[p]![i]!)) p = k;
    [M[i], M[p]] = [M[p]!, M[i]!];
    for (let k = 0; k < n; k += 1)
      if (k !== i) {
        const rowK = M[k]!;
        const rowI = M[i]!;
        const t = rowK[i]! / rowI[i]!;
        for (let j = i; j <= n; j += 1) rowK[j] = rowK[j]! - t * rowI[j]!;
      }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Linearised similarity fit d = shift + scale * p + rotation * perp(p), about the point mean, with standard errors. */
function similarityLine(E: number[], N: number[], dE: number[], dN: number[]): string {
  if (E.length < 3) return 'similarity fit: too few points';
  const cE = mean(E);
  const cN = mean(N);
  const A: number[][] = [];
  const b: number[] = [];
  E.forEach((e, i) => {
    A.push([e - cE, -(N[i]! - cN), 1, 0]);
    b.push(dE[i]!);
    A.push([N[i]! - cN, e - cE, 0, 1]);
    b.push(dN[i]!);
  });
  const [s, th, tE, tN] = solve(A, b) as [number, number, number, number];
  const resid = A.map(
    (row, k) => b[k]! - (row[0]! * s + row[1]! * th + row[2]! * tE + row[3]! * tN),
  );
  const rms = Math.sqrt(sum(resid.map((x) => x * x)) / (resid.length - 4));
  const se = rms / Math.sqrt(sum(A.map((row) => row[0]! ** 2)));
  return `similarity fit about (${cE.toFixed(0)}, ${cN.toFixed(0)}): shift (${fmt(tE)}, ${fmt(tN)}) m; scale ${fmt(s * 1e6, 0)} +/- ${(se * 1e6).toFixed(0)} ppm; rotation ${fmt(th * 1e6, 0)} +/- ${(se * 1e6).toFixed(0)} microrad; residual sd ${rms.toFixed(2)} m`;
}

function summaryLine(rows: readonly FeatureResult[]): string {
  const dE = rows.map((r) => r.dE);
  const dN = rows.map((r) => r.dN);
  const n = rows.length;
  return `mean (${fmt(mean(dE))}, ${fmt(mean(dN))}) m; sd (${sd(dE).toFixed(2)}, ${sd(dN).toFixed(2)}) m; standard error (${(sd(dE) / Math.sqrt(n)).toFixed(2)}, ${(sd(dN) / Math.sqrt(n)).toFixed(2)}) m; RMS ${Math.sqrt(mean(rows.map((r) => r.dE ** 2 + r.dN ** 2))).toFixed(2)} m; n ${n}`;
}

/** The printed report for one result. */
export function formatReport(res: AlignmentResult): string {
  const out: string[] = [];
  for (const layer of ['inset', 'base'] as const) {
    const ok = res[layer].filter(kept);
    out.push(
      '',
      `== ${layer} photo minus OSM, buildings: ${ok.length} of ${res[layer].length} kept (peak ratio >= ${PEAK_MIN}, off the search edge, second peak < ${SECOND_MAX})`,
    );
    for (const r of res[layer]) {
      out.push(
        `- ${r.name ?? r.id} (${r.id}): OSM ${r.osmEast.toFixed(1)}, ${r.osmNorth.toFixed(1)}; photo ${r.photoEast.toFixed(1)}, ${r.photoNorth.toFixed(1)}; delta ${fmt(r.dE)}, ${fmt(r.dN)} m${kept(r) ? '' : ' [rejected]'}`,
      );
    }
    if (ok.length >= 2) {
      out.push(summaryLine(ok));
      out.push(
        similarityLine(
          ok.map((r) => r.osmEast),
          ok.map((r) => r.osmNorth),
          ok.map((r) => r.dE),
          ok.map((r) => r.dN),
        ),
      );
    }
  }
  const d = res.dense.filter((x) => x.ncc >= 0.5);
  out.push(
    '',
    `== dense base minus inset (same ground, both photos): ${d.length} of ${res.dense.length} patches with NCC >= 0.5`,
  );
  if (d.length >= 2) {
    const dE = d.map((x) => x.baseMinusInsetE);
    const dN = d.map((x) => x.baseMinusInsetN);
    out.push(
      `mean (${fmt(mean(dE))}, ${fmt(mean(dN))}) m; sd (${sd(dE).toFixed(2)}, ${sd(dN).toFixed(2)}) m; NCC ${Math.min(...d.map((x) => x.ncc)).toFixed(2)} to ${Math.max(...d.map((x) => x.ncc)).toFixed(2)}`,
    );
    out.push(
      similarityLine(
        d.map((x) => x.east),
        d.map((x) => x.north),
        dE,
        dN,
      ),
    );
  }
  out.push(
    '',
    '== lift corridors in the inset (cross-line offset of the cleared corridor; + = left of the drawn direction)',
  );
  for (const l of res.lifts)
    out.push(
      `- ${l.name ?? '(unnamed)'}: ${fmt(l.crossOffsetM)} m, corridor ${l.corridorWidthM} m, contrast ${l.contrast.toFixed(1)}`,
    );
  return out.join('\n');
}

/** Pairs two results by feature id (kept in both) and prints before and after mean and spread per photo. */
export function formatComparison(before: AlignmentResult, after: AlignmentResult): string {
  const out: string[] = [];
  for (const layer of ['inset', 'base'] as const) {
    const afterById = new Map(after[layer].map((r) => [r.id, r]));
    const pairs = before[layer]
      .map((b) => [b, afterById.get(b.id)] as const)
      .filter(
        (p): p is readonly [FeatureResult, FeatureResult] =>
          p[1] !== undefined && kept(p[0]) && kept(p[1]),
      );
    out.push(
      '',
      `== ${layer}: ${pairs.length} features kept in both runs (before -> after, photo minus OSM)`,
    );
    for (const [b, a] of pairs)
      out.push(
        `- ${b.name ?? b.id}: delta ${fmt(b.dE)}, ${fmt(b.dN)} -> ${fmt(a.dE)}, ${fmt(a.dN)} m (OSM moved ${fmt(a.osmEast - b.osmEast)}, ${fmt(a.osmNorth - b.osmNorth)} m)`,
      );
    if (pairs.length >= 2) {
      out.push(`before: ${summaryLine(pairs.map((p) => p[0]))}`);
      out.push(`after:  ${summaryLine(pairs.map((p) => p[1]))}`);
    }
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { json: { type: 'boolean', default: false }, compare: { type: 'string' } },
  });
  let tick: Tick = () => undefined;
  let finish: (extra?: Record<string, unknown>) => void = () => undefined;
  try {
    const helper = await import('/Users/graham/.claude/lib/progress.mjs');
    const p = helper.progress('imagery-alignment', { everyN: 1 });
    tick = (n, extra) => p.tick(n, extra);
    finish = (extra) => p.done(extra);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.error('heartbeat disabled: helper absent');
  }
  const before =
    values.compare === undefined ? null : parseFile(values.compare, AlignmentResultSchema);
  const res = measureAlignment('.', tick);
  finish({ base: res.base.length, inset: res.inset.length, dense: res.dense.length });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatReport(res)}\n`);
  if (before !== null)
    process.stdout.write(
      `\n== comparison against ${values.compare}${formatComparison(before, res)}\n`,
    );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

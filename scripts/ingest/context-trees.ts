import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decode } from 'jpeg-js';
import { z } from 'zod';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import { ContextManifestSchema } from './context-manifest-schema';
import { CONTEXT_TILES, FADE_OUTER_M, tileKey } from './context-tiles';
import { ContextTreesHeaderSchema, type ContextTreesHeader } from './context-trees-schema';
import { ImageryManifestSchema } from './imagery-manifest-schema';
import {
  LOCKFILE_URL,
  lockSubtreeSha256,
  readFrame,
  resolveCodeCommit,
  sha256Hex,
} from './terrain-deps';
import {
  BROADLEAF_ARCHETYPES,
  CONIFER_ARCHETYPES,
  isConiferArchetype,
  packTrees,
  type TreeRecord,
} from './trees-schema';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/context-trees.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/context-manifest-schema.ts',
  'scripts/ingest/context-tiles.ts',
  'scripts/ingest/context-trees-schema.ts',
  'scripts/ingest/context-trees.ts',
  'scripts/ingest/imagery-manifest-schema.ts',
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/replay.ts',
  'scripts/ingest/terrain-deps.ts',
  'scripts/ingest/trees-schema.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
  'src/schema/terrain.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['jpeg-js', 'zod'];

/** Placement constants (issue #53). They are copied into context-trees.json. */
export const TREE_SEED = 53;
/** Side of one candidate block in metres (issue #59: 15, one candidate per 225 m2). Raise to 18 if the instance count passes 200k. */
export const BLOCK_M = 15;
/** Block mean of (g - max(r, b)) / 255: at or above GREEN_MIN a block is forest. Core tree blocks measure q5 0.046, median 0.089 on the 1.7 m photo. */
export const GREEN_MIN = 0.055;
/** At or above this greenness a tree takes the full height. */
export const GREEN_FULL = 0.11;
/** Keep probability in ring 0, the ring touching the core border. */
export const BASE_DENSITY = 0.85;
/** Ring width as a fraction of the core window diameter: 250 m for the 2.5 km core. */
export const RING_FRACTION = 0.1;
/** The default ring width in metres, used when the caller does not derive one from the core window. */
export const RING_M = 250;
/** Each ring removes this share of what the previous ring kept: p(k) = BASE_DENSITY * (1 - REMOVAL_STEP)^k. */
export const REMOVAL_STEP = 0.1;
/** Blocks at or beyond this distance from the frame centre are never placed (the tiles end there). */
export const OUTER_M = FADE_OUTER_M;
/** Jitter is uniform within plus or minus this share of a block, on both axes. */
export const JITTER_BLOCKS = 0.5;
export const HEIGHT_MIN_M = 8;
export const HEIGHT_MAX_M = 22;
export const HEIGHT_JITTER = 0.1;
export const BROADLEAF_SHARE = 0.75;
export const DARKEN = 0.85;

export const CONTEXT_TREES_BIN_NAME = 'context-trees.bin';
export const CONTEXT_TREES_JSON_NAME = 'context-trees.json';
export const CONTEXT_TREES_REPLAY_NAME = 'context-trees.replay.json';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Context trees replay schema
 * @strategicPurpose Extends the shared replay base with per-input and per-output hashes and tool versions, so context-trees.bin is provably reproducible from the pinned photos and heightfields.
 * @tacticalObjective Validates the base record (effect reduces) plus inputs, outputs, toolVersions (jpeg-js) and lockSubtreeSha256 before data/context-trees.replay.json is written.
 */
export const ContextTreesReplaySchema = ReplayRecordSchema.extend({
  effect: z.literal('reduces'),
  inputs: z.record(z.string(), Sha256Schema),
  outputs: z.record(z.string(), Sha256Schema),
  toolVersions: z.strictObject({ 'jpeg-js': z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
});
export type ContextTreesReplay = z.infer<typeof ContextTreesReplaySchema>;

export class ContextTreesError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

/** A box in local metres. */
export interface LocalBox {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** A decoded photo and the local-metre box it covers. */
export interface ImageSource {
  key: string;
  box: LocalBox;
  width: number;
  height: number;
  /** RGBA bytes, row 0 at the north edge. */
  data: Uint8Array;
}

/** A heightfield: cell (row, col) centre is (originX + (col + 0.5) * cellX, originY - (row + 0.5) * cellY). */
export interface Heightfield {
  width: number;
  height: number;
  originX: number;
  originY: number;
  cellX: number;
  cellY: number;
  values: Float32Array;
}

/** Deterministic 32-bit PRNG (same algorithm as mulberry32 in trees.ts, checked by a test). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The per-block seed: the block index mixed with the run seed (same mix as blockSeed in trees.ts). */
export function blockSeed(blockIndex: number, seed: number): number {
  return (Math.imul(blockIndex + 1, 0x9e3779b1) ^ Math.imul(seed + 1, 0x85ebca6b)) >>> 0;
}

/** Ring index k = floor((r - coreRadius) / ringM) for a block at distance r from the core centre; 0 at or inside the core border. */
export function ringIndex(distanceM: number, coreRadiusM: number, ringM = RING_M): number {
  return Math.max(0, Math.floor((distanceM - coreRadiusM) / ringM));
}

/** Probability a forest block in ring k keeps its tree: baseDensity * (1 - REMOVAL_STEP)^k. */
export function keepProbability(ring: number, baseDensity = BASE_DENSITY): number {
  return baseDensity * (1 - REMOVAL_STEP) ** ring;
}

export interface BlockColour {
  /** Mean of (g - max(r, b)) / 255 over the block's pixels. */
  greenness: number;
  /** Mean sRGB 0 to 1. */
  r: number;
  g: number;
  b: number;
}

/** Mean greenness and colour of the pixels under the block centred at (cx, cy); null when the block misses the photo. */
export function blockColour(
  src: ImageSource,
  cx: number,
  cy: number,
  blockM: number,
): BlockColour | null {
  const mppX = (src.box.xmax - src.box.xmin) / src.width;
  const mppY = (src.box.ymax - src.box.ymin) / src.height;
  const x0 = Math.max(0, Math.floor((cx - blockM / 2 - src.box.xmin) / mppX));
  const x1 = Math.min(
    src.width,
    Math.max(x0 + 1, Math.ceil((cx + blockM / 2 - src.box.xmin) / mppX)),
  );
  const y0 = Math.max(0, Math.floor((src.box.ymax - (cy + blockM / 2)) / mppY));
  const y1 = Math.min(
    src.height,
    Math.max(y0 + 1, Math.ceil((src.box.ymax - (cy - blockM / 2)) / mppY)),
  );
  if (x0 >= src.width || y0 >= src.height || x1 <= x0 || y1 <= y0) return null;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let green = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * src.width + x) * 4;
      const r = src.data[p] as number;
      const g = src.data[p + 1] as number;
      const b = src.data[p + 2] as number;
      sr += r;
      sg += g;
      sb += b;
      green += g - Math.max(r, b);
      n += 1;
    }
  }
  return {
    greenness: green / n / 255,
    r: sr / n / 255,
    g: sg / n / 255,
    b: sb / n / 255,
  };
}

/** Bilinear height at a local point, or null outside the heightfield's box. */
export function sampleHeightfield(hf: Heightfield, x: number, y: number): number | null {
  const fx = (x - hf.originX) / hf.cellX - 0.5;
  const fy = (hf.originY - y) / hf.cellY - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > hf.width - 0.5 || fy > hf.height - 0.5) return null;
  const cx = Math.min(Math.max(fx, 0), hf.width - 1);
  const cy = Math.min(Math.max(fy, 0), hf.height - 1);
  const c0 = Math.floor(cx);
  const r0 = Math.floor(cy);
  const c1 = Math.min(c0 + 1, hf.width - 1);
  const r1 = Math.min(r0 + 1, hf.height - 1);
  const tx = cx - c0;
  const ty = cy - r0;
  const at = (r: number, c: number): number => hf.values[r * hf.width + c] as number;
  const top = at(r0, c0) * (1 - tx) + at(r0, c1) * tx;
  const bottom = at(r1, c0) * (1 - tx) + at(r1, c1) * tx;
  return top * (1 - ty) + bottom * ty;
}

export interface PlaceInput {
  /** Photos in priority order: a block belongs to the first source whose box holds its centre. */
  sources: readonly ImageSource[];
  heightfields: readonly Heightfield[];
  /** Blocks whose centre lies inside this box (the core window) are skipped: the core trees own it. */
  exclude: LocalBox;
}

export interface PlaceOptions {
  seed?: number;
  blockM?: number;
  baseDensity?: number;
  /** Ring width in metres; defaults to RING_M. */
  ringM?: number;
}

export interface PlaceResult {
  trees: TreeRecord[];
  /** Forest blocks inside OUTER_M and outside the core window, before the ring thinning. */
  forestBlocks: number;
}

const inBox = (b: LocalBox, x: number, y: number): boolean =>
  x >= b.xmin && x < b.xmax && y >= b.ymin && y < b.ymax;

/**
 * @displayName Place context trees
 * @strategicPurpose Extends the forest past the core window to the far field from the only data the surrounding tiles have (a 10 m or 1.7 m photo and a bare-earth heightfield), thinned by distance so the trees blend into the bare far ground.
 * @tacticalObjective Scans a BLOCK_M lattice anchored at the frame origin in row-major order over every photo; a block with its centre outside the core window and inside OUTER_M, whose mean greenness reaches GREEN_MIN, sits in ring k = floor((r - core half-width) / ring width) of its distance r from the core centre and keeps a tree when mulberry32(blockSeed(lattice index)) passes BASE_DENSITY * 0.9^k (each ring removes a further 10 percent of what the ring before kept); places it at the block centre plus up to half a block of jitter on each axis, drawn before the keep test, with height from the greenness (8 to 22 m, 10 percent jitter), a class (75 percent broadleaf), an archetype, a rotation, and the block colour darkened 15 percent.
 * @manipulation reduces
 */
export function placeContextTrees(input: PlaceInput, options: PlaceOptions = {}): PlaceResult {
  const seed = options.seed ?? TREE_SEED;
  const blockM = options.blockM ?? BLOCK_M;
  const baseDensity = options.baseDensity ?? BASE_DENSITY;
  const ringM = options.ringM ?? RING_M;
  const coreRadius = (input.exclude.xmax - input.exclude.xmin) / 2;
  const coreCx = (input.exclude.xmin + input.exclude.xmax) / 2;
  const coreCy = (input.exclude.ymin + input.exclude.ymax) / 2;
  const trees: TreeRecord[] = [];
  const seen = new Set<number>();
  let forestBlocks = 0;
  for (const src of input.sources) {
    const ix0 = Math.floor(src.box.xmin / blockM);
    const ix1 = Math.ceil(src.box.xmax / blockM);
    const iy0 = Math.floor(src.box.ymin / blockM);
    const iy1 = Math.ceil(src.box.ymax / blockM);
    // Row-major from the north edge, so the output order does not depend on the photo's pixel order.
    for (let iy = iy1; iy >= iy0; iy -= 1) {
      for (let ix = ix0; ix <= ix1; ix += 1) {
        const cx = (ix + 0.5) * blockM;
        const cy = (iy + 0.5) * blockM;
        if (!inBox(src.box, cx, cy)) continue;
        const index = (iy + 2048) * 4096 + (ix + 2048);
        if (ix < -2048 || ix >= 2048 || iy < -2048 || iy >= 2048) {
          throw new ContextTreesError(
            'BlockOutOfRange',
            `block ${ix},${iy} is outside the lattice`,
          );
        }
        if (seen.has(index)) continue;
        seen.add(index);
        if (inBox(input.exclude, cx, cy)) continue;
        const distance = Math.hypot(cx, cy);
        if (distance >= OUTER_M) continue;
        const colour = blockColour(src, cx, cy, blockM);
        if (colour === null || colour.greenness < GREEN_MIN) continue;
        forestBlocks += 1;
        const rng = mulberry32(blockSeed(index, seed));
        // Every draw is taken before any branch, so a change of density never shifts another block's stream.
        const jx = rng();
        const jy = rng();
        const keep = rng();
        const heightJitter = rng();
        const classDraw = rng();
        const pick = rng();
        const rotation = rng();
        const ring = ringIndex(Math.hypot(cx - coreCx, cy - coreCy), coreRadius, ringM);
        if (keep >= keepProbability(ring, baseDensity)) continue;
        const x = cx + (jx * 2 - 1) * JITTER_BLOCKS * blockM;
        const y = cy + (jy * 2 - 1) * JITTER_BLOCKS * blockM;
        let ground: number | null = null;
        for (const hf of input.heightfields) {
          ground = sampleHeightfield(hf, x, y);
          if (ground !== null) break;
        }
        if (ground === null) continue;
        const t = Math.min(
          Math.max((colour.greenness - GREEN_MIN) / (GREEN_FULL - GREEN_MIN), 0),
          1,
        );
        const height = Math.min(
          Math.max(
            (HEIGHT_MIN_M + t * (HEIGHT_MAX_M - HEIGHT_MIN_M)) *
              (1 + (heightJitter * 2 - 1) * HEIGHT_JITTER),
            HEIGHT_MIN_M,
          ),
          HEIGHT_MAX_M,
        );
        const conifer = classDraw >= BROADLEAF_SHARE;
        const archetype = conifer
          ? (CONIFER_ARCHETYPES[Math.floor(pick * CONIFER_ARCHETYPES.length)] as number)
          : (BROADLEAF_ARCHETYPES[Math.floor(pick * BROADLEAF_ARCHETYPES.length)] as number);
        trees.push({
          east: x,
          north: y,
          groundElev: ground,
          height,
          type: archetype,
          rotation: rotation * 2 * Math.PI,
          r: colour.r * DARKEN,
          g: colour.g * DARKEN,
          b: colour.b * DARKEN,
        });
      }
    }
  }
  return { trees, forestBlocks };
}

/** Tree counts per class and per archetype. */
export function countTrees(trees: readonly TreeRecord[]): {
  types: { broadleaf: number; conifer: number };
  archetypes: number[];
} {
  const archetypes = new Array<number>(6).fill(0);
  let conifer = 0;
  for (const t of trees) {
    archetypes[t.type] = (archetypes[t.type] as number) + 1;
    if (isConiferArchetype(t.type)) conifer += 1;
  }
  return { types: { broadleaf: trees.length - conifer, conifer }, archetypes };
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

const PackageSchema = z.looseObject({ devDependencies: z.record(z.string(), z.string()) });

function jpegJsVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const version = PackageSchema.parse(JSON.parse(text)).devDependencies['jpeg-js'];
  if (version === undefined) {
    throw new ContextTreesError('BadRaster', 'package.json has no jpeg-js devDependency');
  }
  return version;
}

/** Reads a heightfield (header json and f32) through TerrainHeaderSchema, checking the byte length. */
export function readHeightfield(
  dataDir: string,
  jsonPath: string,
  f32Path: string,
): { hf: Heightfield; header: TerrainHeader; sha256: { json: string; f32: string } } {
  const jsonBytes = readFileSync(join(dataDir, jsonPath));
  const f32 = readFileSync(join(dataDir, f32Path));
  const parsed = TerrainHeaderSchema.safeParse(JSON.parse(jsonBytes.toString('utf8')));
  if (!parsed.success) throw new ContextTreesError('HeaderInvalid', parsed.error.message);
  const header = parsed.data;
  if (f32.byteLength !== header.byteLength) {
    throw new ContextTreesError(
      'ManifestDimensionMismatch',
      `${f32Path} is ${f32.byteLength} bytes, header says ${header.byteLength}`,
    );
  }
  const values = new Float32Array(header.width * header.height);
  const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getFloat32(i * 4, true);
  return {
    hf: {
      width: header.width,
      height: header.height,
      originX: header.originX,
      originY: header.originY,
      cellX: header.cellSizeX,
      cellY: header.cellSizeY,
      values,
    },
    header,
    sha256: { json: sha256Hex(jsonBytes), f32: sha256Hex(f32) },
  };
}

function readJpeg(path: string, expectedSha: string, width: number, height: number): Uint8Array {
  const bytes = readFileSync(path);
  const sha = sha256Hex(bytes);
  if (sha !== expectedSha) {
    throw new ContextTreesError(
      'PinnedInputHashMismatch',
      `${path} sha256 ${sha} differs from the manifest pin ${expectedSha}`,
    );
  }
  const image = decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  if (image.width !== width || image.height !== height) {
    throw new ContextTreesError(
      'ManifestDimensionMismatch',
      `${path} is ${image.width}x${image.height}, manifest says ${width}x${height}`,
    );
  }
  return image.data;
}

export interface ContextTreesOptions {
  dataDir: string;
  lockSubtree: string;
  resolveCommit: () => string;
  /** Overrides BLOCK_M. */
  blockM?: number;
}

export interface ContextTreesResult {
  header: ContextTreesHeader;
  replay: ContextTreesReplay;
  trees: TreeRecord[];
  binBytes: number;
}

/**
 * @displayName Build context trees
 * @strategicPurpose Turns the pinned far-field photos and heightfields into one file of simulated trees thinned toward the fade radius, once at ingest, so the browser draws the surrounding forest and never parses a photo.
 * @tacticalObjective Verifies every pinned JPEG against its manifest, decodes the centre photo and the 12 tile photos, reads the centre and 12 tile heightfields and the core window, places trees, and writes data/context-trees.bin, context-trees.json, then context-trees.replay.json last.
 */
export function runContextTrees(options: ContextTreesOptions): ContextTreesResult {
  const { dataDir } = options;
  const blockM = options.blockM ?? BLOCK_M;
  const frameBytes = readFileSync(join(dataDir, 'frame.json'));
  const frame = readFrame(frameBytes);
  const inputs: Record<string, string> = { 'data/frame.json': sha256Hex(frameBytes) };

  const core = readHeightfield(dataDir, 'surface/core.json', 'surface/core.f32');
  inputs['data/surface/core.json'] = core.sha256.json;
  const exclude: LocalBox = {
    xmin: core.hf.originX,
    xmax: core.hf.originX + core.hf.width * core.hf.cellX,
    ymin: core.hf.originY - core.hf.height * core.hf.cellY,
    ymax: core.hf.originY,
  };

  const ringM = RING_FRACTION * (exclude.xmax - exclude.xmin);
  const sources: ImageSource[] = [];
  const heightfields: Heightfield[] = [];

  const centreManifest = ImageryManifestSchema.parse(
    JSON.parse(readFileSync(join(dataDir, 'raw', 'imagery-manifest.json'), 'utf8')),
  );
  inputs['data/raw/naip.jpg'] = centreManifest.sha256;
  sources.push({
    key: 'centre',
    box: {
      xmin: centreManifest.bbox.xmin - frame.originE,
      xmax: centreManifest.bbox.xmax - frame.originE,
      ymin: centreManifest.bbox.ymin - frame.originN,
      ymax: centreManifest.bbox.ymax - frame.originN,
    },
    width: centreManifest.width,
    height: centreManifest.height,
    data: readJpeg(
      join(dataDir, 'raw', 'naip.jpg'),
      centreManifest.sha256,
      centreManifest.width,
      centreManifest.height,
    ),
  });
  const centreTerrain = readHeightfield(dataDir, 'terrain.json', 'terrain.f32');
  inputs['data/terrain.json'] = centreTerrain.sha256.json;
  inputs['data/terrain.f32'] = centreTerrain.sha256.f32;
  heightfields.push(centreTerrain.hf);

  const contextManifestBytes = readFileSync(join(dataDir, 'raw', 'context', 'manifest.json'));
  const contextManifest = ContextManifestSchema.parse(
    JSON.parse(contextManifestBytes.toString('utf8')),
  );
  inputs['data/raw/context/manifest.json'] = sha256Hex(contextManifestBytes);
  for (const [i, j] of CONTEXT_TILES) {
    const key = tileKey(i, j);
    const entry = contextManifest.tiles.find((t) => t.i === i && t.j === j);
    if (entry === undefined) {
      throw new ContextTreesError('PinnedInputHashMismatch', `manifest has no tile ${key}`);
    }
    inputs[`data/raw/context/${key}.jpg`] = entry.imagery.sha256;
    sources.push({
      key,
      box: {
        xmin: entry.bbox.xmin - frame.originE,
        xmax: entry.bbox.xmax - frame.originE,
        ymin: entry.bbox.ymin - frame.originN,
        ymax: entry.bbox.ymax - frame.originN,
      },
      width: entry.imagery.width,
      height: entry.imagery.height,
      data: readJpeg(
        join(dataDir, 'raw', 'context', `${key}.jpg`),
        entry.imagery.sha256,
        entry.imagery.width,
        entry.imagery.height,
      ),
    });
    const tile = readHeightfield(dataDir, `context/${key}.json`, `context/${key}.f32`);
    inputs[`data/context/${key}.json`] = tile.sha256.json;
    inputs[`data/context/${key}.f32`] = tile.sha256.f32;
    heightfields.push(tile.hf);
  }

  const { trees, forestBlocks } = placeContextTrees(
    { sources, heightfields, exclude },
    { seed: TREE_SEED, blockM, baseDensity: BASE_DENSITY, ringM },
  );
  const bin = packTrees(trees);
  const counts = countTrees(trees);
  const headerCandidate = {
    version: 1,
    count: trees.length,
    recordFloats: 9,
    byteOrder: 'LE',
    dtype: 'float32',
    fields: ['east', 'north', 'groundElev', 'height', 'type', 'rotation', 'r', 'g', 'b'],
    byteLength: bin.byteLength,
    types: counts.types,
    archetypes: counts.archetypes,
    params: {
      seed: TREE_SEED,
      blockM,
      greenMin: GREEN_MIN,
      greenFull: GREEN_FULL,
      baseDensity: BASE_DENSITY,
      innerM: (exclude.xmax - exclude.xmin) / 2,
      outerM: OUTER_M,
      jitterM: JITTER_BLOCKS * blockM,
      ringM,
      removalStep: REMOVAL_STEP,
      heightMinM: HEIGHT_MIN_M,
      heightMaxM: HEIGHT_MAX_M,
      heightJitter: HEIGHT_JITTER,
      broadleafShare: BROADLEAF_SHARE,
      darken: DARKEN,
    },
    forestBlocks,
    frame: { file: 'data/frame.json', sha256: inputs['data/frame.json'] },
    sources: Object.entries(inputs)
      .filter(([path]) => path !== 'data/frame.json')
      .map(([path, sha256]) => ({ path, sha256 })),
  };
  // Emitter gate: the header is assembled from raw ingest values, so it is parsed before it is written.
  const gate = ContextTreesHeaderSchema.safeParse(headerCandidate);
  if (!gate.success) throw new ContextTreesError('HeaderInvalid', gate.error.message);
  const header = gate.data;
  const headerBytes = Buffer.from(`${JSON.stringify(header, null, 2)}\n`, 'utf8');

  const outputs: Record<string, string> = {
    [CONTEXT_TREES_BIN_NAME]: sha256Hex(bin),
    [CONTEXT_TREES_JSON_NAME]: sha256Hex(headerBytes),
  };
  const lines = (record: Record<string, string>): string =>
    Object.entries(record)
      .map(([k, v]) => `${k} ${v}\n`)
      .join('');
  const replayGate = ContextTreesReplaySchema.safeParse({
    inputHash: sha256Hex(lines(inputs)),
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(lines(outputs)),
    effect: 'reduces',
    inputs,
    outputs,
    toolVersions: { 'jpeg-js': jpegJsVersion() },
    lockSubtreeSha256: options.lockSubtree,
  });
  if (!replayGate.success) throw new ContextTreesError('HeaderInvalid', replayGate.error.message);
  const replay = replayGate.data;

  mkdirSync(dataDir, { recursive: true });
  writeAtomic(join(dataDir, CONTEXT_TREES_BIN_NAME), bin);
  writeAtomic(join(dataDir, CONTEXT_TREES_JSON_NAME), headerBytes);
  writeAtomic(
    join(dataDir, CONTEXT_TREES_REPLAY_NAME),
    Buffer.from(`${JSON.stringify(replay, null, 2)}\n`, 'utf8'),
  );
  return { header, replay, trees, binBytes: bin.byteLength };
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', default: 'data' },
      'allow-dirty': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'block-m': { type: 'string' },
    },
  });
  if (values.force !== true) {
    throw new ContextTreesError(
      'RefusedOverwrite',
      'ingest:context-trees rewrites data/context-trees.*; pass --force to run it',
    );
  }
  const blockM =
    values['block-m'] === undefined
      ? undefined
      : z.coerce.number().min(10).max(200).parse(values['block-m']);
  const started = performance.now();
  const result = runContextTrees({
    dataDir: values['data-dir'] ?? 'data',
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () =>
      resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty: values['allow-dirty'] === true }),
    ...(blockM === undefined ? {} : { blockM }),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const h = result.header;
  process.stdout.write(
    `ingest:context-trees ok ${h.count} trees (broadleaf ${h.types.broadleaf}, conifer ${h.types.conifer}; archetypes ${h.archetypes.join('/')}) ${result.binBytes} bytes, block ${h.params.blockM} m, forest blocks ${h.forestBlocks}, ${seconds} s\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

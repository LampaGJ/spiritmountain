import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decode } from 'jpeg-js';
import { z } from 'zod';
import { BuildingFeatureCollectionSchema, type BuildingFeature } from '../../src/schema/building';
import { ReplayRecordSchema } from '../../src/schema/replay';
import { TerrainHeaderSchema, type TerrainHeader } from '../../src/schema/terrain';
import { ImageryManifestSchema } from './imagery-manifest-schema';
import { groundSampler, loadGround, type Ground } from './surface-terrain';
import {
  LOCKFILE_URL,
  lockSubtreeSha256,
  readFrame,
  resolveCodeCommit,
  sha256Hex,
} from './terrain-deps';
import { TerrainError, renderHeaderJson } from './terrain';
import {
  BROADLEAF_ARCHETYPES,
  CONIFER_ARCHETYPES,
  TreesHeaderSchema,
  isConiferArchetype,
  packTrees,
  type TreeRecord,
  type TreesHeader,
} from './trees-schema';

/** The transitive repo-import closure of this file, enforced by a test (tests/ingest/trees.test.ts). Its last commit becomes codeCommit. */
export const TRANSFORM_SOURCES: string[] = [
  'scripts/ingest/despike.ts',
  'scripts/ingest/imagery-manifest-schema.ts',
  'scripts/ingest/local-frame.ts',
  'scripts/ingest/manifest-schema.ts',
  'scripts/ingest/replay.ts',
  'scripts/ingest/surface-manifest-schema.ts',
  'scripts/ingest/surface-terrain.ts',
  'scripts/ingest/surface-window.ts',
  'scripts/ingest/terrain-deps.ts',
  'scripts/ingest/terrain.ts',
  'scripts/ingest/trees-schema.ts',
  'scripts/ingest/trees.ts',
  'src/schema/area.ts',
  'src/schema/building.ts',
  'src/schema/frame.ts',
  'src/schema/replay.ts',
  'src/schema/terrain.ts',
];

/** Runtime dependencies whose lockfile subtree is hashed into the replay record. */
export const LOCK_ROOTS: string[] = ['geotiff', 'jpeg-js', 'zod'];

/** Placement and classification constants (issue #30). They are copied into trees.json and the replay record. */
export const TREE_SEED = 30;
export const CANOPY_MIN_CHM_M = 3;
export const GREEN_MARGIN = 8;
export const BLOCK_CELLS = 3;
/** A block is a candidate when at least this many of its 9 cells are canopy. */
export const BLOCK_MIN_CANOPY_CELLS = 5;
export const DENSITY = 0.85;
export const JITTER_M = 1.5;
export const HEIGHT_MIN_M = 3;
export const HEIGHT_MAX_M = 35;
export const HEIGHT_JITTER = 0.1;
export const PEAK_DELTA_M = 1.5;
export const TYPE_OVERRIDE = 0.2;
export const BROADLEAF_SHARE = 0.75;
export const DARKEN = 0.85;

export const TREES_BIN_NAME = 'trees.bin';
export const TREES_JSON_NAME = 'trees.json';
export const TREES_REPLAY_NAME = 'trees.replay.json';
export const NOCANOPY_F32_NAME = 'core-nocanopy.f32';
export const NOCANOPY_JSON_NAME = 'core-nocanopy.json';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * @displayName Trees replay schema
 * @strategicPurpose Extends the shared replay base with the per-input and per-output hashes and tool versions, so trees.bin and core-nocanopy are provably reproducible from the pinned surface, photo and footprints.
 * @tacticalObjective Validates the base record (effect reduces) plus inputs, outputs, toolVersions (jpeg-js and geotiff) and lockSubtreeSha256 before data/trees.replay.json is written.
 */
export const TreesReplaySchema = ReplayRecordSchema.extend({
  effect: z.literal('reduces'),
  inputs: z.record(z.string(), Sha256Schema),
  outputs: z.record(z.string(), Sha256Schema),
  toolVersions: z.strictObject({ 'jpeg-js': z.string().min(1), geotiff: z.string().min(1) }),
  lockSubtreeSha256: Sha256Schema,
});
export type TreesReplay = z.infer<typeof TreesReplaySchema>;

/** A raster in the local metre frame: cell (row, col) centre is (originX + (col + 0.5) * cellM, originY - (row + 0.5) * cellM). */
export interface Grid {
  width: number;
  height: number;
  originX: number;
  originY: number;
  cellM: number;
}

/** Deterministic 32-bit PRNG; the same seed gives the same sequence on every machine. */
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

/** The per-block seed: the block index mixed with the run seed (so neighbouring blocks do not share streams). */
export function blockSeed(blockIndex: number, seed: number): number {
  return (Math.imul(blockIndex + 1, 0x9e3779b1) ^ Math.imul(seed + 1, 0x85ebca6b)) >>> 0;
}

/** Green when G exceeds both R and B by more than the margin (sRGB 0 to 255). */
export function isGreen(r: number, g: number, b: number): boolean {
  return g > r + GREEN_MARGIN && g > b + GREEN_MARGIN;
}

/** Canopy height model: surface minus bare earth per cell; 0 where no bare earth is known (NaN). */
export function computeChm(surface: Float32Array, groundCell: Float32Array): Float32Array {
  const chm = new Float32Array(surface.length);
  for (let i = 0; i < surface.length; i += 1) {
    const g = groundCell[i] as number;
    chm[i] = Number.isNaN(g) ? 0 : Math.fround((surface[i] as number) - g);
  }
  return chm;
}

/** Bare earth at each cell centre of a grid (NaN outside the bare-earth extent). */
export function groundPerCell(ground: Ground, grid: Grid): Float32Array {
  const sample = groundSampler(ground, grid);
  const out = new Float32Array(grid.width * grid.height);
  for (let r = 0; r < grid.height; r += 1) {
    for (let c = 0; c < grid.width; c += 1) {
      out[r * grid.width + c] = sample(r, c) ?? Number.NaN;
    }
  }
  return out;
}

/** The NAIP photo decoded to RGBA and its box in local metres. */
export interface Photo {
  width: number;
  height: number;
  data: Uint8Array;
  /** Local metres of the photo's west edge and north edge, and metres per pixel. */
  west: number;
  north: number;
  metresPerPixel: number;
}

/** sRGB bytes of the photo pixel under each cell centre (3 per cell), nearest pixel, clamped to the photo. */
export function photoPerCell(photo: Photo, grid: Grid): Uint8Array {
  const out = new Uint8Array(grid.width * grid.height * 3);
  for (let r = 0; r < grid.height; r += 1) {
    const y = grid.originY - (r + 0.5) * grid.cellM;
    const py = Math.min(
      Math.max(Math.floor((photo.north - y) / photo.metresPerPixel), 0),
      photo.height - 1,
    );
    for (let c = 0; c < grid.width; c += 1) {
      const x = grid.originX + (c + 0.5) * grid.cellM;
      const px = Math.min(
        Math.max(Math.floor((x - photo.west) / photo.metresPerPixel), 0),
        photo.width - 1,
      );
      const p = (py * photo.width + px) * 4;
      const o = (r * grid.width + c) * 3;
      out[o] = photo.data[p] as number;
      out[o + 1] = photo.data[p + 1] as number;
      out[o + 2] = photo.data[p + 2] as number;
    }
  }
  return out;
}

/** 1 where the cell's photo pixel is green. */
export function greenPerCell(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgb.length / 3);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = isGreen(rgb[i * 3] as number, rgb[i * 3 + 1] as number, rgb[i * 3 + 2] as number)
      ? 1
      : 0;
  }
  return out;
}

/** Even-odd point-in-polygon over all rings of one polygon (outer ring and holes). */
function inPolygon(
  x: number,
  y: number,
  rings: readonly (readonly (readonly number[])[])[],
): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i] as readonly number[];
      const b = ring[j] as readonly number[];
      const ax = a[0] as number;
      const ay = a[1] as number;
      const bx = b[0] as number;
      const by = b[1] as number;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
  }
  return inside;
}

/** 1 where the cell centre lies inside any building footprint (polygons in local metres). */
export function rasterizeBuildings(features: readonly BuildingFeature[], grid: Grid): Uint8Array {
  const out = new Uint8Array(grid.width * grid.height);
  for (const f of features) {
    const rings = f.geometry.coordinates;
    let xmin = Infinity;
    let xmax = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const ring of rings) {
      for (const p of ring) {
        xmin = Math.min(xmin, p[0] as number);
        xmax = Math.max(xmax, p[0] as number);
        ymin = Math.min(ymin, p[1] as number);
        ymax = Math.max(ymax, p[1] as number);
      }
    }
    const c0 = Math.max(0, Math.floor((xmin - grid.originX) / grid.cellM - 0.5));
    const c1 = Math.min(grid.width - 1, Math.ceil((xmax - grid.originX) / grid.cellM - 0.5));
    const r0 = Math.max(0, Math.floor((grid.originY - ymax) / grid.cellM - 0.5));
    const r1 = Math.min(grid.height - 1, Math.ceil((grid.originY - ymin) / grid.cellM - 0.5));
    for (let r = r0; r <= r1; r += 1) {
      const y = grid.originY - (r + 0.5) * grid.cellM;
      for (let c = c0; c <= c1; c += 1) {
        const x = grid.originX + (c + 0.5) * grid.cellM;
        if (inPolygon(x, y, rings)) out[r * grid.width + c] = 1;
      }
    }
  }
  return out;
}

/** Canopy cell: height above bare earth at least CANOPY_MIN_CHM_M, a green photo pixel, and not inside a building footprint. */
export function canopyMask(chm: Float32Array, green: Uint8Array, building: Uint8Array): Uint8Array {
  const out = new Uint8Array(chm.length);
  for (let i = 0; i < chm.length; i += 1) {
    out[i] = (chm[i] as number) >= CANOPY_MIN_CHM_M && green[i] === 1 && building[i] === 0 ? 1 : 0;
  }
  return out;
}

/** A tall, non-building cell that is not green is still replaced in the canopy-free core when at least this many of its 8 neighbours are canopy. */
export const HOLE_MIN_NEIGHBOURS = 5;

/**
 * The canopy mask plus its holes: tall (at least CANOPY_MIN_CHM_M), non-building cells whose photo pixel is not green (shadowed
 * crowns) but that sit among canopy cells. Used only for the canopy-free core, so shadowed crowns do not stay behind as grey spikes
 * under the simulated trees; tree placement keeps the plain mask.
 */
export function fillCanopyHoles(
  mask: Uint8Array,
  chm: Float32Array,
  building: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(mask);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const i = r * width + c;
      if (mask[i] === 1 || building[i] === 1 || (chm[i] as number) < CANOPY_MIN_CHM_M) continue;
      let around = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
          around += mask[rr * width + cc] as number;
        }
      }
      if (around >= HOLE_MIN_NEIGHBOURS) out[i] = 1;
    }
  }
  return out;
}

export interface PlaceInput {
  grid: Grid;
  chm: Float32Array;
  mask: Uint8Array;
  /** sRGB bytes of the photo pixel per cell, 3 per cell. */
  rgb: Uint8Array;
  /** Bare earth at a local point, or null outside its extent. */
  groundAt: (x: number, y: number) => number | null;
}

export interface PlaceOptions {
  /** Added to every block seed; the committed run uses TREE_SEED. */
  seed?: number;
  /** Probability a candidate block keeps its tree. */
  density?: number;
}

/**
 * @displayName Place simulated trees
 * @strategicPurpose Replaces the LiDAR canopy surface (which gives blobs, not trees) with one simulated tree per 3x3 block of canopy cells, so the scene can draw individual crowns of varied height, type and colour.
 * @tacticalObjective Scans 3x3 blocks in row-major order; a block with at least 5 canopy cells keeps a tree when mulberry32(blockSeed(blockIndex)) passes the density; places it at the block centre plus up to 1.5 m of jitter, with height from the tallest canopy cell (clamped 3 to 35 m, 10 percent jitter), a peaky-texture conifer or broadleaf class (redrawn 20 percent of the time, 75 percent broadleaf), an archetype within the class, a rotation, and the photo colour darkened 15 percent.
 * @manipulation reduces
 */
export function placeTrees(input: PlaceInput, options: PlaceOptions = {}): TreeRecord[] {
  const { grid, chm, mask, rgb, groundAt } = input;
  const seed = options.seed ?? TREE_SEED;
  const density = options.density ?? DENSITY;
  const blocksW = Math.ceil(grid.width / BLOCK_CELLS);
  const blocksH = Math.ceil(grid.height / BLOCK_CELLS);
  const trees: TreeRecord[] = [];
  for (let br = 0; br < blocksH; br += 1) {
    for (let bc = 0; bc < blocksW; bc += 1) {
      let canopy = 0;
      let best = -1;
      for (let r = br * BLOCK_CELLS; r < Math.min(grid.height, (br + 1) * BLOCK_CELLS); r += 1) {
        for (let c = bc * BLOCK_CELLS; c < Math.min(grid.width, (bc + 1) * BLOCK_CELLS); c += 1) {
          const i = r * grid.width + c;
          if (mask[i] !== 1) continue;
          canopy += 1;
          if (best < 0 || (chm[i] as number) > (chm[best] as number)) best = i;
        }
      }
      if (canopy < BLOCK_MIN_CANOPY_CELLS || best < 0) continue;
      const rng = mulberry32(blockSeed(br * blocksW + bc, seed));
      // Every draw is taken before any branch, so a change of density never shifts another block's stream.
      const keep = rng();
      const jx = rng();
      const jy = rng();
      const heightJitter = rng();
      const override = rng();
      const overrideClass = rng();
      const pick = rng();
      const rotation = rng();
      if (keep >= density) continue;
      const x =
        grid.originX + (bc * BLOCK_CELLS + BLOCK_CELLS / 2) * grid.cellM + (jx * 2 - 1) * JITTER_M;
      const y =
        grid.originY - (br * BLOCK_CELLS + BLOCK_CELLS / 2) * grid.cellM + (jy * 2 - 1) * JITTER_M;
      const ground = groundAt(x, y);
      if (ground === null) continue;
      const bestRow = Math.floor(best / grid.width);
      const bestCol = best % grid.width;
      let sum = 0;
      let n = 0;
      for (let r = Math.max(0, bestRow - 1); r <= Math.min(grid.height - 1, bestRow + 1); r += 1) {
        for (let c = Math.max(0, bestCol - 1); c <= Math.min(grid.width - 1, bestCol + 1); c += 1) {
          sum += chm[r * grid.width + c] as number;
          n += 1;
        }
      }
      const peaky = (chm[best] as number) - sum / n > PEAK_DELTA_M;
      let conifer = peaky;
      if (override < TYPE_OVERRIDE) conifer = overrideClass >= BROADLEAF_SHARE;
      const archetype = conifer
        ? (CONIFER_ARCHETYPES[Math.floor(pick * CONIFER_ARCHETYPES.length)] as number)
        : (BROADLEAF_ARCHETYPES[Math.floor(pick * BROADLEAF_ARCHETYPES.length)] as number);
      const clamped = Math.min(Math.max(chm[best] as number, HEIGHT_MIN_M), HEIGHT_MAX_M);
      trees.push({
        east: x,
        north: y,
        groundElev: ground,
        height: clamped * (1 + (heightJitter * 2 - 1) * HEIGHT_JITTER),
        type: archetype,
        rotation: rotation * 2 * Math.PI,
        r: ((rgb[best * 3] as number) / 255) * DARKEN,
        g: ((rgb[best * 3 + 1] as number) / 255) * DARKEN,
        b: ((rgb[best * 3 + 2] as number) / 255) * DARKEN,
      });
    }
  }
  return trees;
}

/** The core heightfield with every canopy cell replaced by bare earth; roofs and non-green cells keep the surface. */
export function buildNoCanopy(
  surface: Float32Array,
  groundCell: Float32Array,
  mask: Uint8Array,
): { values: Float32Array; replaced: number } {
  const values = new Float32Array(surface);
  let replaced = 0;
  for (let i = 0; i < values.length; i += 1) {
    const g = groundCell[i] as number;
    if (mask[i] === 1 && !Number.isNaN(g)) {
      values[i] = Math.fround(g);
      replaced += 1;
    }
  }
  return { values, replaced };
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

/** Reads a surface heightfield (core.f32 with core.json), checking the header and byte length. */
export function readSurfaceCore(
  dataDir: string,
  f32Name: string,
  jsonName: string,
): { header: TerrainHeader; values: Float32Array; sha256: { f32: string; json: string } } {
  const jsonBytes = readFileSync(join(dataDir, 'surface', jsonName));
  const f32 = readFileSync(join(dataDir, 'surface', f32Name));
  const parsed = TerrainHeaderSchema.safeParse(JSON.parse(jsonBytes.toString('utf8')));
  if (!parsed.success) throw new TerrainError('HeaderInvalid', parsed.error.message);
  const header = parsed.data;
  if (f32.byteLength !== header.byteLength) {
    throw new TerrainError(
      'ManifestDimensionMismatch',
      `${f32Name} is ${f32.byteLength} bytes, header says ${header.byteLength}`,
    );
  }
  const values = new Float32Array(header.width * header.height);
  const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getFloat32(i * 4, true);
  return { header, values, sha256: { f32: sha256Hex(f32), json: sha256Hex(jsonBytes) } };
}

function floatBytes(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i += 1) view.setFloat32(i * 4, values[i] as number, true);
  return out;
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

function toolVersion(section: 'dependencies' | 'devDependencies', name: string): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = z
    .looseObject({
      dependencies: z.record(z.string(), z.string()),
      devDependencies: z.record(z.string(), z.string()),
    })
    .safeParse(JSON.parse(text));
  const version = parsed.success ? parsed.data[section][name] : undefined;
  if (version === undefined) throw new TerrainError('BadRaster', `package.json has no ${name}`);
  return version;
}

export interface TreesOptions {
  dataDir: string;
  lockSubtree: string;
  resolveCommit: () => string;
  /** Overrides DENSITY. */
  density?: number;
}

export interface TreesResult {
  header: TreesHeader;
  replay: TreesReplay;
  trees: TreeRecord[];
  binBytes: number;
}

/**
 * @displayName Build trees and canopy-free core
 * @strategicPurpose Turns the despiked LiDAR surface, the NAIP photo and the building footprints into a file of simulated trees and a core heightfield without canopy, once at ingest, so the browser draws individual trees and never parses the photo or the canopy model.
 * @tacticalObjective Verifies the pinned JPEG against its manifest, builds the canopy mask, places trees, replaces canopy cells by bare earth, and writes data/trees.bin, trees.json, surface/core-nocanopy.f32, core-nocanopy.json, then trees.replay.json last.
 */
export function runTrees(options: TreesOptions): TreesResult {
  const { dataDir } = options;
  const frameBytes = readFileSync(join(dataDir, 'frame.json'));
  const frame = readFrame(frameBytes);
  const core = readSurfaceCore(dataDir, 'core.f32', 'core.json');
  const ground = loadGround(dataDir);
  const manifest = ImageryManifestSchema.parse(
    JSON.parse(readFileSync(join(dataDir, 'raw', 'imagery-manifest.json'), 'utf8')),
  );
  const jpeg = readFileSync(join(dataDir, 'raw', 'naip.jpg'));
  const jpegSha = sha256Hex(jpeg);
  if (jpegSha !== manifest.sha256) {
    throw new TerrainError(
      'PinnedInputHashMismatch',
      `naip.jpg sha256 ${jpegSha} differs from the manifest pin ${manifest.sha256}`,
    );
  }
  const buildingsBytes = readFileSync(join(dataDir, 'buildings.geojson'));
  const buildings = BuildingFeatureCollectionSchema.safeParse(
    JSON.parse(buildingsBytes.toString('utf8')),
  );
  if (!buildings.success) throw new TerrainError('HeaderInvalid', buildings.error.message);

  const grid: Grid = {
    width: core.header.width,
    height: core.header.height,
    originX: core.header.originX,
    originY: core.header.originY,
    cellM: core.header.cellSizeX,
  };
  const image = decode(jpeg, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  if (image.width !== manifest.width || image.height !== manifest.height) {
    throw new TerrainError(
      'ManifestDimensionMismatch',
      `JPEG is ${image.width}x${image.height}, manifest says ${manifest.width}x${manifest.height}`,
    );
  }
  const photo: Photo = {
    width: image.width,
    height: image.height,
    data: image.data,
    west: manifest.bbox.xmin - frame.originE,
    north: manifest.bbox.ymax - frame.originN,
    metresPerPixel: (manifest.bbox.xmax - manifest.bbox.xmin) / manifest.width,
  };
  const groundCell = groundPerCell(ground, grid);
  const chm = computeChm(core.values, groundCell);
  const rgb = photoPerCell(photo, grid);
  const buildingCells = rasterizeBuildings(buildings.data.features, grid);
  const mask = canopyMask(chm, greenPerCell(rgb), buildingCells);
  const density = options.density ?? DENSITY;
  const pointGround = (x: number, y: number): number | null =>
    groundSampler(ground, { originX: x, originY: y, cellM: 0 })(0, 0);
  const trees = placeTrees(
    { grid, chm, mask, rgb, groundAt: pointGround },
    { seed: TREE_SEED, density },
  );
  const noCanopy = buildNoCanopy(
    core.values,
    groundCell,
    fillCanopyHoles(mask, chm, buildingCells, grid.width, grid.height),
  );

  let canopyCells = 0;
  for (const m of mask) canopyCells += m;
  const bin = packTrees(trees);
  const f32 = floatBytes(noCanopy.values);
  let minElev = Infinity;
  let maxElev = -Infinity;
  for (const v of noCanopy.values) {
    minElev = Math.min(minElev, v);
    maxElev = Math.max(maxElev, v);
  }
  const ncHeader = TerrainHeaderSchema.safeParse({ ...core.header, minElev, maxElev });
  if (!ncHeader.success) throw new TerrainError('HeaderInvalid', ncHeader.error.message);
  const ncJson = Buffer.from(renderHeaderJson(ncHeader.data), 'utf8');

  const inputs: Record<string, string> = {
    'data/surface/core.f32': core.sha256.f32,
    'data/surface/core.json': core.sha256.json,
    'data/terrain.f32+terrain.json': ground.sha256,
    'data/raw/naip.jpg': jpegSha,
    'data/buildings.geojson': sha256Hex(buildingsBytes),
    'data/frame.json': sha256Hex(frameBytes),
  };
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
      density,
      blockCells: BLOCK_CELLS,
      blockMinCanopyCells: BLOCK_MIN_CANOPY_CELLS,
      canopyMinChmM: CANOPY_MIN_CHM_M,
      greenMargin: GREEN_MARGIN,
      jitterM: JITTER_M,
      heightMinM: HEIGHT_MIN_M,
      heightMaxM: HEIGHT_MAX_M,
      heightJitter: HEIGHT_JITTER,
      peakDeltaM: PEAK_DELTA_M,
      typeOverride: TYPE_OVERRIDE,
      broadleafShare: BROADLEAF_SHARE,
      darken: DARKEN,
    },
    canopyCells,
    nocanopyCellsReplaced: noCanopy.replaced,
    frame: { file: 'data/frame.json', sha256: inputs['data/frame.json'] },
    sources: Object.entries(inputs)
      .filter(([path]) => path !== 'data/frame.json')
      .map(([path, sha256]) => ({ path, sha256 })),
  };
  // Emitter gate: the header is assembled from raw ingest values, so it is parsed before it is written.
  const gate = TreesHeaderSchema.safeParse(headerCandidate);
  if (!gate.success) throw new TerrainError('HeaderInvalid', gate.error.message);
  const header = gate.data;
  const headerBytes = Buffer.from(`${JSON.stringify(header, null, 2)}\n`, 'utf8');

  const outputs: Record<string, string> = {
    [TREES_BIN_NAME]: sha256Hex(bin),
    [TREES_JSON_NAME]: sha256Hex(headerBytes),
    [NOCANOPY_F32_NAME]: sha256Hex(f32),
    [NOCANOPY_JSON_NAME]: sha256Hex(ncJson),
  };
  const inputHash = sha256Hex(
    Object.entries(inputs)
      .map(([path, sha]) => `${path} ${sha}\n`)
      .join(''),
  );
  const replayGate = TreesReplaySchema.safeParse({
    inputHash,
    codeCommit: options.resolveCommit(),
    outputHash: sha256Hex(
      Object.entries(outputs)
        .map(([n, sha]) => `${n} ${sha}\n`)
        .join(''),
    ),
    effect: 'reduces',
    inputs,
    outputs,
    toolVersions: {
      'jpeg-js': toolVersion('devDependencies', 'jpeg-js'),
      geotiff: toolVersion('dependencies', 'geotiff'),
    },
    lockSubtreeSha256: options.lockSubtree,
  });
  if (!replayGate.success) throw new TerrainError('HeaderInvalid', replayGate.error.message);
  const replay = replayGate.data;

  mkdirSync(join(dataDir, 'surface'), { recursive: true });
  writeAtomic(join(dataDir, TREES_BIN_NAME), bin);
  writeAtomic(join(dataDir, TREES_JSON_NAME), headerBytes);
  writeAtomic(join(dataDir, 'surface', NOCANOPY_F32_NAME), f32);
  writeAtomic(join(dataDir, 'surface', NOCANOPY_JSON_NAME), ncJson);
  writeAtomic(
    join(dataDir, TREES_REPLAY_NAME),
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
      density: { type: 'string' },
    },
  });
  const allowDirty = values['allow-dirty'] === true;
  const density =
    values.density === undefined
      ? undefined
      : z.coerce.number().min(0).max(1).parse(values.density);
  const started = performance.now();
  const result = runTrees({
    dataDir: values['data-dir'] ?? 'data',
    lockSubtree: lockSubtreeSha256(readFileSync(LOCKFILE_URL, 'utf8'), LOCK_ROOTS),
    resolveCommit: () => resolveCodeCommit(TRANSFORM_SOURCES, { allowDirty }),
    ...(density === undefined ? {} : { density }),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const h = result.header;
  process.stdout.write(
    `ingest:trees ok ${h.count} trees (broadleaf ${h.types.broadleaf}, conifer ${h.types.conifer}; archetypes ${h.archetypes.join('/')}) ${result.binBytes} bytes, density ${h.params.density}, canopy cells ${h.canopyCells}, nocanopy cells replaced ${h.nocanopyCellsReplaced}, ${seconds} s\n`,
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

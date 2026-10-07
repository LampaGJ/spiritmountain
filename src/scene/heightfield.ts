/**
 * Heightfield sampling and the mesh grid, in one module.
 *
 * Owner: issue #12. Consumer: issue #11 (terrain mesh). The terrain mesh and the area lines MUST
 * both read heights through createMeshSurface(), so a line is draped on the surface that is drawn.
 *
 * Conventions (all world metres, no vertical exaggeration here):
 * - data is row-major, row 0 is the northmost row, column 0 is the westmost column.
 * - data[0] sits at (originEast, originNorth). Column c is at originEast + c * cellSizeEast.
 *   Row r is at originNorth - r * cellSizeNorth. Samples are points, not pixel areas: a\n   *   the loader (#11) converts the header's corner origin to the first cell centre, so originEast and originNorth here are already cell centres.
 * - The mesh is a PlaneGeometry grid of segX by segY cells. Every cell is split along the
 *   south-west to north-east diagonal into two triangles (three.js PlaneGeometry order).
 */

export interface Heightfield {
  readonly cols: number;
  readonly rows: number;
  readonly originEast: number;
  readonly originNorth: number;
  readonly cellSizeEast: number;
  readonly cellSizeNorth: number;
  readonly data: Float32Array;
}

/** Upper bound on mesh cells per axis. A larger heightfield is subsampled by a stride. */
export const MAX_MESH_SEGMENTS = 512;

export interface HeightSample {
  readonly height: number;
  /** True when the requested point was outside the field and was clamped to its edge. */
  readonly clamped: boolean;
}

export interface MeshGrid {
  readonly segX: number;
  readonly segY: number;
  /** Heightfield cells per mesh cell along each axis. 1 when no subsampling is needed; may be fractional. */
  readonly strideX: number;
  readonly strideY: number;
}

export interface MeshSurface {
  readonly field: Heightfield;
  readonly grid: MeshGrid;
  /** (segX + 1) * (segY + 1) vertex heights, row-major, row 0 northmost. */
  readonly heights: Float32Array;
  /** Plan-view size and centre of the mesh, for PlaneGeometry and its translation. */
  readonly extent: {
    readonly widthM: number;
    readonly heightM: number;
    readonly centreEast: number;
    readonly centreNorth: number;
  };
  /** Height of the triangulated mesh surface at a point; clamps outside the mesh. */
  sample(east: number, north: number): HeightSample;
  /** Fractional mesh-cell coordinates: u grows east, v grows south, both unclamped. */
  toMeshUV(east: number, north: number): { u: number; v: number };
  /**
   * For a composite (surfaceSampler): every drawn surface the sample may come from, finest first. A draped line
   * splits at the mesh edges of each so it lies on the drawn triangles everywhere, not only on this surface's grid.
   * Absent on a plain mesh surface, which stands for itself.
   */
  readonly edgeSurfaces?: readonly MeshSurface[];
}

/** The surfaces whose mesh edges a line draped on `surface` must split at: its composite layers, or itself. */
export function edgeSurfacesOf(surface: MeshSurface): readonly MeshSurface[] {
  return surface.edgeSurfaces ?? [surface];
}

function assertField(field: Heightfield): void {
  if (field.cols < 2 || field.rows < 2) {
    throw new Error(`heightfield must be at least 2 by 2, got ${field.cols} by ${field.rows}`);
  }
  if (field.data.length !== field.cols * field.rows) {
    throw new Error(
      `heightfield data length ${field.data.length} does not equal cols * rows = ${field.cols * field.rows}`,
    );
  }
  if (!(field.cellSizeEast > 0) || !(field.cellSizeNorth > 0)) {
    throw new Error('heightfield cell sizes must be positive');
  }
}

/** Bilinear sample at fractional column and row indices; clamps to the field. */
export function sampleIndex(field: Heightfield, col: number, row: number): HeightSample {
  const maxC = field.cols - 1;
  const maxR = field.rows - 1;
  const clamped = col < 0 || col > maxC || row < 0 || row > maxR;
  const c = Math.min(Math.max(col, 0), maxC);
  const r = Math.min(Math.max(row, 0), maxR);
  const c0 = Math.min(Math.floor(c), maxC - 1);
  const r0 = Math.min(Math.floor(r), maxR - 1);
  const fx = c - c0;
  const fy = r - r0;
  const at = (cc: number, rr: number): number => field.data[rr * field.cols + cc] as number;
  const top = at(c0, r0) * (1 - fx) + at(c0 + 1, r0) * fx;
  const bottom = at(c0, r0 + 1) * (1 - fx) + at(c0 + 1, r0 + 1) * fx;
  return { height: top * (1 - fy) + bottom * fy, clamped };
}

/** Bilinear sample of the full-resolution field at a world point (east, north). */
export function sampleHeight(field: Heightfield, east: number, north: number): HeightSample {
  assertField(field);
  return sampleIndex(
    field,
    (east - field.originEast) / field.cellSizeEast,
    (field.originNorth - north) / field.cellSizeNorth,
  );
}

/** Mesh cell counts and strides. segX = min(cols - 1, max); stride = (cols - 1) / segX. */
export function computeMeshGrid(field: Heightfield, maxSegments = MAX_MESH_SEGMENTS): MeshGrid {
  assertField(field);
  const segX = Math.min(field.cols - 1, maxSegments);
  const segY = Math.min(field.rows - 1, maxSegments);
  return { segX, segY, strideX: (field.cols - 1) / segX, strideY: (field.rows - 1) / segY };
}

/** Vertex heights of the mesh grid, point-sampled from the full-resolution field. */
export function meshHeights(field: Heightfield, grid: MeshGrid): Float32Array {
  const out = new Float32Array((grid.segX + 1) * (grid.segY + 1));
  for (let j = 0; j <= grid.segY; j += 1) {
    for (let i = 0; i <= grid.segX; i += 1) {
      out[j * (grid.segX + 1) + i] = sampleIndex(field, i * grid.strideX, j * grid.strideY).height;
    }
  }
  return out;
}

export function createMeshSurface(
  field: Heightfield,
  maxSegments = MAX_MESH_SEGMENTS,
): MeshSurface {
  const grid = computeMeshGrid(field, maxSegments);
  const heights = meshHeights(field, grid);
  const stepE = grid.strideX * field.cellSizeEast;
  const stepN = grid.strideY * field.cellSizeNorth;
  const widthM = grid.segX * stepE;
  const heightM = grid.segY * stepN;
  const toMeshUV = (east: number, north: number) => ({
    u: (east - field.originEast) / stepE,
    v: (field.originNorth - north) / stepN,
  });
  const sample = (east: number, north: number): HeightSample => {
    const { u: rawU, v: rawV } = toMeshUV(east, north);
    const clamped = rawU < 0 || rawU > grid.segX || rawV < 0 || rawV > grid.segY;
    const u = Math.min(Math.max(rawU, 0), grid.segX);
    const v = Math.min(Math.max(rawV, 0), grid.segY);
    const i = Math.min(Math.floor(u), grid.segX - 1);
    const j = Math.min(Math.floor(v), grid.segY - 1);
    const fu = u - i;
    const fv = v - j;
    const w = grid.segX + 1;
    const nw = heights[j * w + i] as number;
    const ne = heights[j * w + i + 1] as number;
    const sw = heights[(j + 1) * w + i] as number;
    const se = heights[(j + 1) * w + i + 1] as number;
    const height =
      fu + fv <= 1
        ? nw + fu * (ne - nw) + fv * (sw - nw)
        : se + (1 - fu) * (sw - se) + (1 - fv) * (ne - se);
    return { height, clamped };
  };
  return {
    field,
    grid,
    heights,
    extent: {
      widthM,
      heightM,
      centreEast: field.originEast + widthM / 2,
      centreNorth: field.originNorth - heightM / 2,
    },
    sample,
    toMeshUV,
  };
}

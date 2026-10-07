/** Half-width of the local statistics window: 4 gives a 9x9 window of cells. */
export const SPIKE_WINDOW_RADIUS = 4;
/** Cells across the local statistics window, recorded in the replay record. */
export const SPIKE_WINDOW = 2 * SPIKE_WINDOW_RADIUS + 1;
/** A cell must stand at least this many metres above its local median to be a spike, whatever the local spread. */
export const SPIKE_MIN_M = 3;
/** Robust sigma multiple: a cell must also exceed SPIKE_K x 1.4826 x MAD above the median (1.4826 scales MAD to a normal sigma). */
export const SPIKE_K = 3;
/** A cell is trusted when at least this many of its 8 neighbours lie within SPIKE_SUPPORT_TOL_M of its value; a spike has fewer. */
export const SPIKE_SUPPORT = 4;
/**
 * A corner of a roof or ridge has only 3 neighbours in its own 8, so SPIKE_SUPPORT alone would erode every rectangle's
 * corners. A cell with fewer than SPIKE_SUPPORT close neighbours is still trusted when at least this many of the 24 cells
 * in its 5x5 block (itself excluded) are within SPIKE_SUPPORT_TOL_M: a plateau corner has 8, a needle or a tee at most 3.
 */
export const SPIKE_SUPPORT_WIDE = 8;
/** A neighbour supports a cell when its value differs by no more than this many metres. */
export const SPIKE_SUPPORT_TOL_M = 3;
/** Passes of the local filter; a cell propped up by neighbours that an earlier pass removes goes in a later one. */
export const SPIKE_PASSES = 3;
/**
 * Bare-earth ceiling: no first-return cell may stand more than this many metres above the bare-earth height at the same
 * place. 35 m keeps every roof and every tree in the resort; anything higher is an artefact (tower, cable, cloud return)
 * and is clamped, whatever support it has from its neighbours.
 */
export const CANOPY_CAP_M = 35;

const MAD_TO_SIGMA = 1.4826;
const WINDOW_CELLS = SPIKE_WINDOW ** 2;

export interface DespikePass {
  spikesRemoved: number;
  /** The largest value - median among the cells removed in this pass; 0 when none. */
  maxDelta: number;
}

export interface DespikeResult {
  data: Float32Array;
  passes: DespikePass[];
  /** Maximum over valid cells before and after the filter. */
  maxBefore: number;
  maxAfter: number;
  /** Cells clamped by the bare-earth ceiling after the local passes; 0 when no ground sampler is given. */
  cappedToCanopy: number;
  /** The largest value - (ground + CANOPY_CAP_M) among the capped cells; 0 when none. */
  maxExcessM: number;
}

/** Bare-earth height under surface cell (row, col), or null where the bare-earth grid does not reach (the cap is then skipped for that cell). */
export type GroundSampler = (row: number, col: number) => number | null;

/** Median of the first n entries of the scratch array, sorted in place by numeric value; the mean of the middle two when n is even. */
function medianOf(scratch: Float64Array, n: number): number {
  const view = scratch.subarray(0, n);
  view.sort();
  const mid = n >> 1;
  return n % 2 === 1
    ? (view[mid] as number)
    : ((view[mid - 1] as number) + (view[mid] as number)) / 2;
}

function maxValid(data: Float32Array, nodata: Uint8Array): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i += 1) {
    if (nodata[i] === 0 && (data[i] as number) > best) best = data[i] as number;
  }
  return best;
}

/**
 * @displayName Isolated spike filter
 * @strategicPurpose Removes single-return outliers (birds, wires, towers, noise) that max-pooling keeps as thin spires in the first-return surface, while leaving roofs, tree crowns and ridges, which have supporting neighbours.
 * @tacticalObjective Per valid cell, takes the median and MAD of the valid cells in a 9x9 window; a cell is a spike when it exceeds the median by more than max(SPIKE_MIN_M, SPIKE_K x 1.4826 x MAD) and fewer than SPIKE_SUPPORT of its 8 neighbours and fewer than SPIKE_SUPPORT_WIDE of its 5x5 block lie within SPIKE_SUPPORT_TOL_M of it, and it becomes the median. Three passes, each judged against the previous pass's output. Then, when a ground sampler is given, every valid cell above ground + CANOPY_CAP_M becomes the 9x9 median of the post-pass surface if that median is within the cap, else ground + CANOPY_CAP_M (judged against the post-pass snapshot, so order does not matter), counted as cappedToCanopy. Nodata cells (mask 1) are never changed and never counted as neighbours or window members.
 * @manipulation preserves
 * Raster shape and every non-spike cell are unchanged; only isolated upward outliers change. Deterministic: the median is a numeric sort of a fixed-size scratch array in row-major window order, with no randomness or clock.
 */
export function despike(
  data: Float32Array,
  cols: number,
  rows: number,
  nodata: Uint8Array,
  opts: { passes?: number; ground?: GroundSampler } = {},
): DespikeResult {
  const passCount = opts.passes ?? SPIKE_PASSES;
  const maxBefore = maxValid(data, nodata);
  let current = Float32Array.from(data);
  const passes: DespikePass[] = [];
  const scratch = new Float64Array(WINDOW_CELLS);
  for (let pass = 0; pass < passCount; pass += 1) {
    const next = Float32Array.from(current);
    let spikesRemoved = 0;
    let maxDelta = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        if (nodata[i] === 1) continue;
        const v = current[i] as number;
        const r0 = Math.max(0, r - SPIKE_WINDOW_RADIUS);
        const r1 = Math.min(rows - 1, r + SPIKE_WINDOW_RADIUS);
        const c0 = Math.max(0, c - SPIKE_WINDOW_RADIUS);
        const c1 = Math.min(cols - 1, c + SPIKE_WINDOW_RADIUS);
        let n = 0;
        for (let rr = r0; rr <= r1; rr += 1) {
          for (let cc = c0; cc <= c1; cc += 1) {
            const j = rr * cols + cc;
            if (nodata[j] === 0) {
              scratch[n] = current[j] as number;
              n += 1;
            }
          }
        }
        const median = medianOf(scratch, n);
        if (v - median <= SPIKE_MIN_M) continue; // cheap exit; the MAD threshold is never below SPIKE_MIN_M
        for (let k = 0; k < n; k += 1) scratch[k] = Math.abs((scratch[k] as number) - median);
        const mad = medianOf(scratch, n);
        if (v - median <= Math.max(SPIKE_MIN_M, SPIKE_K * MAD_TO_SIGMA * mad)) continue;
        let support = 0;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            const j = rr * cols + cc;
            if (nodata[j] === 0 && Math.abs((current[j] as number) - v) <= SPIKE_SUPPORT_TOL_M)
              support += 1;
          }
        }
        if (support >= SPIKE_SUPPORT) continue;
        let wide = 0;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            const j = rr * cols + cc;
            if (nodata[j] === 0 && Math.abs((current[j] as number) - v) <= SPIKE_SUPPORT_TOL_M)
              wide += 1;
          }
        }
        if (wide >= SPIKE_SUPPORT_WIDE) continue;
        next[i] = median;
        spikesRemoved += 1;
        if (v - median > maxDelta) maxDelta = v - median;
      }
    }
    passes.push({ spikesRemoved, maxDelta: Math.round(maxDelta * 1e6) / 1e6 });
    current = next;
  }
  let cappedToCanopy = 0;
  let maxExcess = 0;
  const ground = opts.ground;
  if (ground !== undefined) {
    const snapshot = current;
    const capped = Float32Array.from(snapshot);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        if (nodata[i] === 1) continue;
        const g = ground(r, c);
        if (g === null) continue;
        const ceiling = g + CANOPY_CAP_M;
        const v = snapshot[i] as number;
        if (v <= ceiling) continue;
        const r0 = Math.max(0, r - SPIKE_WINDOW_RADIUS);
        const r1 = Math.min(rows - 1, r + SPIKE_WINDOW_RADIUS);
        const c0 = Math.max(0, c - SPIKE_WINDOW_RADIUS);
        const c1 = Math.min(cols - 1, c + SPIKE_WINDOW_RADIUS);
        let n = 0;
        for (let rr = r0; rr <= r1; rr += 1) {
          for (let cc = c0; cc <= c1; cc += 1) {
            const j = rr * cols + cc;
            if (nodata[j] === 0) {
              scratch[n] = snapshot[j] as number;
              n += 1;
            }
          }
        }
        const median = medianOf(scratch, n);
        capped[i] = median <= ceiling ? median : ceiling;
        cappedToCanopy += 1;
        if (v - ceiling > maxExcess) maxExcess = v - ceiling;
      }
    }
    current = capped;
  }
  return {
    data: current,
    passes,
    maxBefore,
    maxAfter: maxValid(current, nodata),
    cappedToCanopy,
    maxExcessM: Math.round(maxExcess * 1e6) / 1e6,
  };
}

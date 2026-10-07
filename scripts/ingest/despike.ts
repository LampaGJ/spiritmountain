/** Half-width of the local statistics window: 3 gives a 7x7 window of cells. */
export const SPIKE_WINDOW_RADIUS = 3;
/** A cell must stand at least this many metres above its local median to be a spike, whatever the local spread. */
export const SPIKE_MIN_M = 5;
/** Robust sigma multiple: a cell must also exceed SPIKE_K x 1.4826 x MAD above the median (1.4826 scales MAD to a normal sigma). */
export const SPIKE_K = 3;
/** A spike has fewer than this many of its 8 neighbours within SPIKE_SUPPORT_TOL_M of its value; roofs and tree crowns have more. */
export const SPIKE_SUPPORT = 3;
/** A neighbour supports a cell when its value differs by no more than this many metres. */
export const SPIKE_SUPPORT_TOL_M = 3;
/** Passes of the filter; a cell propped up by neighbours that a first pass removes goes in the second. */
export const SPIKE_PASSES = 2;

const MAD_TO_SIGMA = 1.4826;
const WINDOW_CELLS = (2 * SPIKE_WINDOW_RADIUS + 1) ** 2;

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
}

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
 * @tacticalObjective Per valid cell, takes the median and MAD of the valid cells in a 7x7 window; a cell is a spike when it exceeds the median by more than max(SPIKE_MIN_M, SPIKE_K x 1.4826 x MAD) and fewer than SPIKE_SUPPORT of its 8 neighbours lie within SPIKE_SUPPORT_TOL_M of it, and it becomes the median. Two passes, each judged against the previous pass's output. Nodata cells (mask 1) are never changed and never counted as neighbours or window members.
 * @manipulation preserves
 * Raster shape and every non-spike cell are unchanged; only isolated upward outliers change. Deterministic: the median is a numeric sort of a fixed-size scratch array in row-major window order, with no randomness or clock.
 */
export function despike(
  data: Float32Array,
  cols: number,
  rows: number,
  nodata: Uint8Array,
  opts: { passes?: number } = {},
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
        next[i] = median;
        spikesRemoved += 1;
        if (v - median > maxDelta) maxDelta = v - median;
      }
    }
    passes.push({ spikesRemoved, maxDelta: Math.round(maxDelta * 1e6) / 1e6 });
    current = next;
  }
  return { data: current, passes, maxBefore, maxAfter: maxValid(current, nodata) };
}

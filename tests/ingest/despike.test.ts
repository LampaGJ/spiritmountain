import { describe, expect, it } from 'vitest';
import { CANOPY_CAP_M, SPIKE_MIN_M, SPIKE_PASSES, despike } from '../../scripts/ingest/despike';

const N = 31;

/** A flat field of 300 m with optional raised cells given as [row, col, value]. */
const field = (raised: [number, number, number][] = []): Float32Array => {
  const out = new Float32Array(N * N).fill(300);
  for (const [r, c, v] of raised) out[r * N + c] = v;
  return out;
};
const noMask = (): Uint8Array => new Uint8Array(N * N);

describe('despike', () => {
  it('removes a single 30 m needle on flat ground', () => {
    const out = despike(field([[15, 15, 330]]), N, N, noMask());
    expect(out.data[15 * N + 15]).toBe(300);
    expect(out.passes[0]?.spikesRemoved).toBe(1);
    expect(out.passes[0]?.maxDelta).toBe(30);
    expect(out.maxBefore).toBe(330);
    expect(out.maxAfter).toBe(300);
  });

  it('removes a 2-cell needle', () => {
    const out = despike(
      field([
        [15, 15, 330],
        [15, 16, 330],
      ]),
      N,
      N,
      noMask(),
    );
    expect(out.maxAfter).toBe(300);
  });

  it('removes a 4-cell tee within the three passes', () => {
    const tee: [number, number, number][] = [
      [15, 15, 330],
      [15, 14, 330],
      [15, 16, 330],
      [14, 15, 330],
    ];
    const two = despike(field(tee), N, N, noMask());
    expect(two.data[15 * N + 15]).toBe(300);
    expect(two.maxAfter).toBe(300);
    expect(two.passes.length).toBe(SPIKE_PASSES);
    expect(two.passes.reduce((n, p) => n + p.spikesRemoved, 0)).toBeGreaterThanOrEqual(4);
  });

  it('leaves a 12x12 plateau 8 m high (a roof) untouched', () => {
    const roof: [number, number, number][] = [];
    for (let r = 10; r < 22; r += 1) for (let c = 10; c < 22; c += 1) roof.push([r, c, 308]);
    const input = field(roof);
    const out = despike(input, N, N, noMask());
    expect([...out.data]).toEqual([...input]);
    expect(out.passes.map((p) => p.spikesRemoved)).toEqual([0, 0, 0]);
  });

  it('leaves a 3-cell-wide ridge untouched even when it is tall', () => {
    const ridge: [number, number, number][] = [];
    for (let r = 5; r < 25; r += 1) for (let c = 14; c < 17; c += 1) ridge.push([r, c, 325]);
    const input = field(ridge);
    const out = despike(input, N, N, noMask());
    expect([...out.data]).toEqual([...input]);
  });

  it('leaves a hole untouched and never uses it as a neighbour', () => {
    const mask = noMask();
    for (let r = 12; r < 19; r += 1) for (let c = 12; c < 19; c += 1) mask[r * N + c] = 1;
    // fill the hole with values that would otherwise look like support for the needle
    const input = field();
    for (let r = 12; r < 19; r += 1) for (let c = 12; c < 19; c += 1) input[r * N + c] = 100;
    input[15 * N + 20] = 340; // a needle beside the hole
    const out = despike(input, N, N, mask);
    for (let r = 12; r < 19; r += 1)
      for (let c = 12; c < 19; c += 1) {
        expect(out.data[r * N + c]).toBe(100);
      }
    expect(out.data[15 * N + 20]).toBe(300);
  });

  it('does not treat a rise below SPIKE_MIN_M as a spike', () => {
    const out = despike(field([[15, 15, 300 + SPIKE_MIN_M]]), N, N, noMask());
    expect(out.passes[0]?.spikesRemoved).toBe(0);
  });

  it('is byte-identical across two runs and does not mutate its input', () => {
    const input = field([
      [3, 3, 340],
      [15, 15, 330],
      [15, 16, 331],
    ]);
    const copy = Float32Array.from(input);
    const a = despike(input, N, N, noMask());
    const b = despike(input, N, N, noMask());
    expect(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer))).toBe(true);
    expect(a.passes).toEqual(b.passes);
    expect([...input]).toEqual([...copy]);
  });

  it('removes a 60 m needle over flat ground with the local rule alone', () => {
    const out = despike(field([[15, 15, 360]]), N, N, noMask());
    expect(out.data[15 * N + 15]).toBe(300);
    expect(out.passes[0]?.spikesRemoved).toBe(1);
    expect(out.passes[0]?.maxDelta).toBe(60);
    expect(out.cappedToCanopy).toBe(0);
  });

  describe('bare-earth ceiling', () => {
    const ground = () => 300;
    const block = (r0: number, r1: number, c0: number, c1: number, v: number) => {
      const cells: [number, number, number][] = [];
      for (let r = r0; r < r1; r += 1) for (let c = c0; c < c1; c += 1) cells.push([r, c, v]);
      return cells;
    };

    it('caps a 40 wide plateau 50 m high (supported, so the local rule keeps it) to ground + 35 m', () => {
      const wide = 40;
      const rows = 60;
      const input = new Float32Array(wide * rows).fill(300);
      for (let r = 10; r < 50; r += 1) for (let c = 0; c < wide; c += 1) input[r * wide + c] = 350;
      const out = despike(input, wide, rows, new Uint8Array(wide * rows), { ground });
      expect(out.data[30 * wide + 20]).toBe(300 + CANOPY_CAP_M);
      expect(out.maxAfter).toBe(300 + CANOPY_CAP_M);
      expect(out.cappedToCanopy).toBe(40 * 40);
      expect(out.maxExcessM).toBe(15);
    });

    it('leaves a 25 m tree crown untouched', () => {
      const input = field(block(12, 18, 12, 18, 325));
      const out = despike(input, N, N, noMask(), { ground });
      expect([...out.data]).toEqual([...input]);
      expect(out.cappedToCanopy).toBe(0);
      expect(out.maxExcessM).toBe(0);
    });

    it('clamps to the local median when that median is itself under the cap', () => {
      // a 3x3 patch 40 m up survives the local rule, sits on 300 ground, and its median in a 9x9 window is 300
      const input = field(block(14, 17, 14, 17, 340));
      const out = despike(input, N, N, noMask(), { ground });
      expect(out.maxAfter).toBeLessThanOrEqual(300 + CANOPY_CAP_M);
      expect(
        out.cappedToCanopy + out.passes.reduce((n, p) => n + p.spikesRemoved, 0),
      ).toBeGreaterThan(0);
    });

    it('skips cells where the ground sampler has no ground', () => {
      const input = field(block(10, 22, 10, 22, 360));
      const out = despike(input, N, N, noMask(), { ground: () => null });
      expect([...out.data]).toEqual([...input]);
      expect(out.cappedToCanopy).toBe(0);
    });

    it('is byte-identical across two runs', () => {
      const input = field(block(5, 25, 5, 25, 355));
      const a = despike(input, N, N, noMask(), { ground });
      const b = despike(input, N, N, noMask(), { ground });
      expect(Buffer.from(a.data.buffer).equals(Buffer.from(b.data.buffer))).toBe(true);
      expect(a.cappedToCanopy).toBe(b.cappedToCanopy);
      expect(a.maxExcessM).toBe(b.maxExcessM);
    });
  });
});

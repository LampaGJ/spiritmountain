import { describe, expect, it } from 'vitest';
import {
  cameraMoved,
  declutterStep,
  drawSign,
  initialDeclutterState,
  stepFade,
  DECLUTTER_SHOW_HOLD_MS,
  SIGN_CANVAS_HEIGHT,
  SIGN_CANVAS_WIDTH,
  SIGN_FADE_MS,
  TRAIL_CHIP_R_FRACTION,
  type DeclutterState,
  type ScreenRect,
  type SignContext2D,
} from '../../src/scene/billboards';

const rect = (x: number, y = 0, priority = 0): ScreenRect => ({
  x,
  y,
  w: 100,
  h: 40,
  distance: 10,
  priority,
});

/** Runs passes of `dt` ms; `rectsAt(pass)` gives the rects for that pass. Returns each pass's visibility of sign 1. */
function run(
  passes: number,
  dt: number,
  rectsAt: (pass: number) => ScreenRect[],
  start: DeclutterState[],
): { states: DeclutterState[]; visible: boolean[] } {
  let states = start;
  const visible: boolean[] = [];
  for (let i = 0; i < passes; i++) {
    states = declutterStep(rectsAt(i), states, dt);
    visible.push((states[1] as DeclutterState).visible);
  }
  return { states, visible };
}

const changes = (seq: boolean[], initial: boolean): number =>
  seq.reduce((n, v, i) => n + (v !== (i === 0 ? initial : seq[i - 1]) ? 1 : 0), 0);

describe('declutterStep', () => {
  const visibleState: DeclutterState = { visible: true, clearMs: 0 };
  const hiddenState: DeclutterState = { visible: false, clearMs: 0 };

  it('shows a fresh sign on its first clear pass and keeps two clear signs', () => {
    const next = declutterStep(
      [rect(0), rect(300)],
      [initialDeclutterState(), initialDeclutterState()],
      150,
    );
    expect(next.map((s) => s.visible)).toEqual([true, true]);
  });

  it('keeps a visible sign while the overlap is at most 25 percent of its area', () => {
    // Sign 1 overlaps sign 0 by 25 px of 100: exactly 25 percent, not more.
    const next = declutterStep([rect(0), rect(75)], [visibleState, visibleState], 150);
    expect(next[1]?.visible).toBe(true);
  });

  it('hides a visible lower-ranked sign once more than 25 percent of it is covered', () => {
    const next = declutterStep([rect(0), rect(70)], [visibleState, visibleState], 150);
    expect(next.map((s) => s.visible)).toEqual([true, false]);
  });

  it('a flicker sequence (overlap toggling every pass) yields at most one visibility change', () => {
    const { visible } = run(20, 150, (pass) => [rect(0), rect(pass % 2 === 0 ? 30 : 400)], [
      visibleState,
      visibleState,
    ]);
    expect(changes(visible, true)).toBeLessThanOrEqual(1);
  });

  it('a hidden sign clear for 500 ms stays hidden, and for 600 ms it shows', () => {
    const apart = (): ScreenRect[] => [rect(0), rect(400)];
    const five = run(5, 100, apart, [visibleState, hiddenState]);
    expect(five.visible.every((v) => !v)).toBe(true);
    const six = run(6, 100, apart, [visibleState, hiddenState]);
    expect(six.visible.slice(0, 5).every((v) => !v)).toBe(true);
    expect(six.visible[5]).toBe(true);
    expect(DECLUTTER_SHOW_HOLD_MS).toBe(600);
  });

  it('an overlap empties the banked clear time', () => {
    const states = declutterStep([rect(0), rect(400)], [visibleState, hiddenState], 400);
    expect(states[1]?.clearMs).toBe(400);
    const hit = declutterStep([rect(0), rect(10)], states, 100);
    expect(hit[1]).toEqual({ visible: false, clearMs: 0 });
  });
});

describe('stepFade', () => {
  it('moves by dt / SIGN_FADE_MS toward the target and clamps to 0..1', () => {
    expect(stepFade(0, true, SIGN_FADE_MS / 2)).toBeCloseTo(0.5, 9);
    expect(stepFade(0.5, true, SIGN_FADE_MS * 2)).toBe(1);
    expect(stepFade(1, false, SIGN_FADE_MS / 4)).toBeCloseTo(0.75, 9);
    expect(stepFade(0.1, false, SIGN_FADE_MS)).toBe(0);
  });
});

describe('cameraMoved', () => {
  const pose = { x: 0, y: 100, z: 0, dx: 0, dy: 0, dz: -1 };
  it('is true with no previous pose, false for a small move, true past 2 m or 0.5 degrees', () => {
    expect(cameraMoved(null, pose)).toBe(true);
    expect(cameraMoved(pose, { ...pose, x: 1.5 })).toBe(false);
    expect(cameraMoved(pose, { ...pose, x: 2.5 })).toBe(true);
    const tilt = (deg: number) => ({
      ...pose,
      dx: Math.sin((deg * Math.PI) / 180),
      dz: -Math.cos((deg * Math.PI) / 180),
    });
    expect(cameraMoved(pose, tilt(0.4))).toBe(false);
    expect(cameraMoved(pose, tilt(0.6))).toBe(true);
  });
});

interface Rec {
  fillTexts: { text: string; x: number }[];
  arcs: { x: number; r: number }[];
}

function recorder(): { ctx: SignContext2D; rec: Rec } {
  const rec: Rec = { fillTexts: [], arcs: [] };
  const ctx = {
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect() {},
    beginPath() {},
    moveTo() {},
    arc(x: number, _y: number, r: number) {
      rec.arcs.push({ x, r });
    },
    arcTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    fillText(text: string, x: number) {
      rec.fillTexts.push({ text, x });
    },
    measureText: (text: string) => ({ width: text.length * 5 }),
  };
  return { ctx: ctx as unknown as SignContext2D, rec };
}

describe('drawSign layout (#63)', () => {
  const base = { glyph: false, width: SIGN_CANVAS_WIDTH, height: SIGN_CANVAS_HEIGHT };

  it('centres a place sign name and chip row on the canvas centre', () => {
    const { ctx, rec } = recorder();
    drawSign(ctx, {
      ...base,
      activities: ['hike', 'mountain-bike'],
      label: '2 trails',
      family: 'concentration',
      place: 'Peak',
    });
    expect(rec.fillTexts.find((t) => t.text === 'Peak')?.x).toBe(SIGN_CANVAS_WIDTH / 2);
    expect(rec.fillTexts.find((t) => t.text === '2 trails')?.x).toBe(SIGN_CANVAS_WIDTH / 2);
    const mid = rec.arcs[0] && rec.arcs[1] ? (rec.arcs[0].x + rec.arcs[1].x) / 2 : -1;
    expect(mid).toBeCloseTo(SIGN_CANVAS_WIDTH / 2, 9);
  });

  it('centres the chip row of a plain concentration sign', () => {
    const { ctx, rec } = recorder();
    drawSign(ctx, { ...base, activities: ['hike'], label: '3 trails', family: 'concentration' });
    expect(rec.arcs[0]?.x).toBeCloseTo(SIGN_CANVAS_WIDTH / 2, 9);
  });

  it('draws trail chips at 1.4 x the earlier 0.19 of the panel height', () => {
    const { ctx, rec } = recorder();
    drawSign(ctx, { ...base, activities: ['hike'], label: 'Birch', family: 'trail' });
    expect(TRAIL_CHIP_R_FRACTION).toBeCloseTo(0.19 * 1.4, 9);
    expect(rec.arcs[0]?.r).toBeCloseTo(SIGN_CANVAS_HEIGHT * 0.19 * 1.4, 9);
  });
});

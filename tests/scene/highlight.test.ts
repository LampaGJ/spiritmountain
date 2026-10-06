import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_COLOR,
  INITIAL_STATE,
  createHighlighter,
  highlightedIds,
  reduce,
} from '../../src/scene/highlight';

describe('interaction state machine', () => {
  it('hover only, selected only, and both', () => {
    const hover = reduce(INITIAL_STATE, { type: 'hover', areaId: 'a' });
    expect([...highlightedIds(hover)]).toEqual(['a']);
    const both = reduce(hover, { type: 'select', areaId: 'b' });
    expect([...highlightedIds(both)].sort()).toEqual(['a', 'b']);
  });

  it('leaving hover keeps the selected highlight', () => {
    const state = reduce(reduce(INITIAL_STATE, { type: 'select', areaId: 'b' }), {
      type: 'hover',
      areaId: null,
    });
    expect([...highlightedIds(state)]).toEqual(['b']);
  });

  it('clear-selection clears only the selection', () => {
    const state = reduce(
      reduce(reduce(INITIAL_STATE, { type: 'select', areaId: 'b' }), {
        type: 'hover',
        areaId: 'a',
      }),
      { type: 'clear-selection' },
    );
    expect(state).toEqual({ hoverId: 'a', selectedId: null });
  });
});

describe('createHighlighter', () => {
  function build() {
    const shared = new LineMaterial({ color: 0xd55e00, linewidth: 3 });
    shared.resolution.set(800, 600);
    const mk = () => {
      const geometry = new LineGeometry();
      geometry.setPositions([0, 0, 0, 1, 0, 0]);
      return new Line2(geometry, shared);
    };
    const lineA = mk();
    const lineB = mk();
    const lines = new Map([
      ['a', [lineA]],
      ['b', [lineB]],
    ]);
    return { shared, lineA, lineB, highlighter: createHighlighter(lines) };
  }

  it('swaps colour only: same linewidth, shared material untouched, restored on leave', () => {
    const { shared, lineA, lineB, highlighter } = build();
    highlighter.apply(reduce(INITIAL_STATE, { type: 'hover', areaId: 'a' }));
    expect(lineA.material).not.toBe(shared);
    expect(lineA.material.color.getHex()).toBe(HIGHLIGHT_COLOR);
    expect(lineA.material.linewidth).toBe(shared.linewidth);
    expect(lineA.material.resolution.x).toBe(800);
    expect(lineB.material).toBe(shared);
    expect(shared.color.getHex()).toBe(0xd55e00);
    expect(shared.linewidth).toBe(3);

    highlighter.apply(INITIAL_STATE);
    expect(lineA.material).toBe(shared);
    expect(shared.color.getHex()).toBe(0xd55e00);
  });

  it('keeps the selected line highlighted when hover leaves', () => {
    const { shared, lineA, highlighter } = build();
    let state = reduce(INITIAL_STATE, { type: 'select', areaId: 'a' });
    state = reduce(state, { type: 'hover', areaId: 'a' });
    highlighter.apply(state);
    state = reduce(state, { type: 'hover', areaId: null });
    highlighter.apply(state);
    expect(lineA.material).not.toBe(shared);
    highlighter.apply(reduce(state, { type: 'clear-selection' }));
    expect(lineA.material).toBe(shared);
  });
});

import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { describe, expect, it } from 'vitest';
import { buildAreaLayer } from '../../src/scene/areas';
import { createMeshSurface } from '../../src/scene/heightfield';
import type { Activity } from '../../src/scene/sport-routing';
import type { Annotation } from '../../src/schema/annotation';
import type { Area } from '../../src/schema/area';
import { makeFixtureField } from '../fixtures/make-field';
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

describe('highlight after route (#40)', () => {
  const run: Area = {
    id: 'way/1',
    kind: 'downhill-run',
    name: null,
    difficulty: null,
    osmTags: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0, 0],
        [60, 0, 0],
      ],
    },
  };
  const annotations = new Map<string, Annotation>([
    [
      'way/1',
      {
        areaId: 'way/1',
        activities: (['alpine-ski', 'snowboard'] as Activity[]).map((activity) => ({
          activity,
          seasons: [],
          notes: '',
        })),
        stakeholders: [],
        notes: '',
      },
    ],
  ]);
  function build() {
    const layer = buildAreaLayer(
      [run],
      createMeshSurface(makeFixtureField(), 16),
      (e, n, z) => [e, z, -n],
      { width: 800, height: 600 },
    );
    const lines = new Map([...layer.registry].map(([id, entry]) => [id, entry.lines]));
    return {
      layer,
      line: layer.registry.get('way/1')?.lines[0] as Line2,
      highlighter: createHighlighter(lines),
    };
  }
  const hover = reduce(INITIAL_STATE, { type: 'hover', areaId: 'way/1' });

  it('route, highlight, unhighlight returns the routed material', () => {
    const { layer, line, highlighter } = build();
    layer.route(annotations, new Set<Activity>(['snowboard']));
    highlighter.apply(hover);
    expect(line.material.color.getHex()).toBe(HIGHLIGHT_COLOR);
    highlighter.apply(INITIAL_STATE);
    expect(line.material).toBe(layer.materials.snowboard);
  });

  it('route while highlighted keeps the highlight, and the later unhighlight returns the new routed material', () => {
    const { layer, line, highlighter } = build();
    highlighter.apply(hover);
    const highlight = line.material;
    expect(highlight.color.getHex()).toBe(HIGHLIGHT_COLOR);
    layer.route(annotations, new Set<Activity>(['snowboard']));
    expect(line.material).toBe(highlight);
    highlighter.apply(INITIAL_STATE);
    expect(line.material).toBe(layer.materials.snowboard);
  });

  it('hands the highlighted ids to the wall hook on every apply (#74)', () => {
    const { lineA } = { lineA: new Line2(new LineGeometry(), new LineMaterial()) };
    const seen: string[][] = [];
    const highlighter = createHighlighter(new Map([['a', [lineA]]]), (ids) => {
      seen.push([...ids]);
    });
    highlighter.apply(reduce(INITIAL_STATE, { type: 'hover', areaId: 'a' }));
    highlighter.apply(INITIAL_STATE);
    expect(seen).toEqual([['a'], []]);
  });
});

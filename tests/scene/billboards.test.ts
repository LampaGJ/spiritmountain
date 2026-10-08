import { Mesh, type MeshBasicMaterial, PerspectiveCamera, Sprite, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fadeAlpha } from '../../scripts/ingest/context-tiles';
import type { SceneMapper } from '../../src/scene/areas';
import {
  areaCentroid,
  areaVertices,
  buildBillboardLayer,
  clusterAreas,
  concentrateTracks,
  contrastRatio,
  declutter,
  drawSign,
  labelColorFor,
  lineCentroid,
  loadSignFont,
  mergeTrackPath,
  planSigns,
  planTrailSigns,
  pointerVertices,
  pointAlong,
  polygonCentroid,
  signTextureKey,
  signWidthPx,
  LABEL_LIGHT,
  POINTER_ANGLE_DEG,
  SIGN_OFFSET_M,
  SIGN_RENDER_ORDER,
  SIGN_PANEL_COLOR,
  type BillboardFrameHost,
  type ClusterInput,
  type SignCanvas,
  type SignContext2D,
  type TrackPoints,
} from '../../src/scene/billboards';
import { ElevatedGroup, effectiveScale } from '../../src/scene/elevated';
import { createMeshSurface, type MeshSurface } from '../../src/scene/heightfield';
import { SPORT_COLOR } from '../../src/scene/palette';
import type { Activity } from '../../src/scene/sport-routing';
import { ActivitySchema, type Annotation } from '../../src/schema/annotation';
import type { Area } from '../../src/schema/area';
import { signGlyph } from '../../src/ui/icons';
import { makeFixtureField } from '../fixtures/make-field';

const input = (id: string, sport: Activity | null, east: number, north: number): ClusterInput => ({
  id,
  sport,
  east,
  north,
});

describe('clusterAreas', () => {
  it('merges same-sport centroids at 149 m and splits them at 151 m', () => {
    expect(
      clusterAreas([input('way/1', 'hike', 0, 0), input('way/2', 'hike', 149, 0)]),
    ).toHaveLength(1);
    expect(
      clusterAreas([input('way/1', 'hike', 0, 0), input('way/2', 'hike', 151, 0)]),
    ).toHaveLength(2);
  });

  it('links a chain A-B-C at 100 m steps transitively into one cluster', () => {
    const clusters = clusterAreas([
      input('way/1', 'hike', 0, 0),
      input('way/2', 'hike', 100, 0),
      input('way/3', 'hike', 200, 0),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.memberIds).toEqual(['way/1', 'way/2', 'way/3']);
    expect(clusters[0]?.east).toBeCloseTo(100, 9);
  });

  it('never merges different sports at the same point', () => {
    const clusters = clusterAreas([input('way/1', 'hike', 0, 0), input('way/2', 'fat-bike', 0, 0)]);
    expect(clusters.map((c) => c.sport)).toEqual(['fat-bike', 'hike']);
  });

  it('gives a null-routed area no cluster and a lift-ride area one', () => {
    const clusters = clusterAreas([input('way/1', null, 0, 0), input('way/2', 'lift-ride', 0, 0)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sport).toBe('lift-ride');
  });

  it('sorts by sport then smallest member id by code point', () => {
    const clusters = clusterAreas([
      input('way/9', 'hike', 1000, 0),
      input('way/10', 'hike', 0, 0),
      input('way/5', 'alpine-ski', 0, 0),
    ]);
    expect(clusters.map((c) => c.memberIds[0])).toEqual(['way/5', 'way/10', 'way/9']);
  });
});

describe('centroids', () => {
  it('puts a line centroid at its length midpoint', () => {
    // 100 m east then 300 m north: total 400, midpoint 200 m along, i.e. 100 m up the second leg.
    const c = lineCentroid([
      [0, 0],
      [100, 0],
      [100, 300],
    ]);
    expect(c.east).toBeCloseTo(100, 9);
    expect(c.north).toBeCloseTo(100, 9);
  });

  it('puts a polygon centroid at the ring area centroid, not the vertex mean', () => {
    // An L shape: 0..20 x 0..10 plus 0..10 x 10..20. Area 300; centroid (25/3, 25/3).
    const ring = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
      [0, 0],
    ];
    const c = polygonCentroid(ring);
    expect(c.east).toBeCloseTo(25 / 3, 9);
    expect(c.north).toBeCloseTo(25 / 3, 9);
  });

  it('falls back to the vertex mean for a degenerate ring', () => {
    const c = polygonCentroid([
      [0, 0],
      [10, 0],
      [20, 0],
      [0, 0],
    ]);
    expect(c.east).toBeCloseTo(10, 9);
    expect(c.north).toBeCloseTo(0, 9);
  });

  it('dispatches on the geometry type', () => {
    const line = areaCentroid({
      type: 'LineString',
      coordinates: [
        [0, 0, 1],
        [10, 0, 1],
      ],
    });
    expect(line.east).toBeCloseTo(5, 9);
  });
});

const seg = (
  id: string,
  kind: Area['kind'],
  name: string | null,
  coords: ReadonlyArray<readonly [number, number]>,
): Area =>
  ({
    id,
    kind,
    name,
    difficulty: null,
    osmTags: {},
    geometry: { type: 'LineString', coordinates: coords.map(([e, n]) => [e, n, 0]) },
  }) as unknown as Area;

const note = (areaId: string, activities: Activity[]): Annotation =>
  ({
    areaId,
    activities: activities.map((activity) => ({ activity, seasons: [], notes: '' })),
    stakeholders: [],
    notes: '',
  }) as Annotation;

const all = (areas: readonly Area[]): Set<string> => new Set(areas.map((a) => a.id));

const track = (key: string, points: ReadonlyArray<readonly [number, number]>): TrackPoints => ({
  key,
  points: points.map(([east, north]) => ({ east, north, weight: 1 })),
});

describe('areaVertices', () => {
  it('weights vertices by length share, summing to the track length', () => {
    const v = areaVertices({
      type: 'LineString',
      coordinates: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 300, 0],
      ],
    });
    expect(v.map((p) => p.weight)).toEqual([50, 200, 150]);
  });

  it('gives a zero-length geometry weight 1 per vertex', () => {
    const v = areaVertices({
      type: 'LineString',
      coordinates: [
        [5, 5, 0],
        [5, 5, 0],
      ],
    });
    expect(v.map((p) => p.weight)).toEqual([1, 1]);
  });
});

describe('concentrateTracks', () => {
  it('joins tracks whose vertices are 249 m apart and separates them at 251 m', () => {
    const near = [track('a', [[0, 0]]), track('b', [[249, 0]])];
    expect(concentrateTracks(near)).toEqual([[0, 1]]);
    const far = [track('a', [[0, 0]]), track('b', [[251, 0]])];
    expect(concentrateTracks(far)).toEqual([[0], [1]]);
  });

  it('uses any vertex of a track, not its ends or centroid', () => {
    const long = track('a', [
      [0, 0],
      [1000, 0],
      [2000, 0],
    ]);
    const other = track('b', [[1000, 249]]);
    expect(concentrateTracks([long, other])).toEqual([[0, 1]]);
  });

  it('links a chain transitively', () => {
    const chain = [0, 1, 2, 3].map((i) => track(`t${i}`, [[i * 200, 0]]));
    expect(concentrateTracks(chain)).toEqual([[0, 1, 2, 3]]);
  });
});

describe('planSigns', () => {
  it('puts one sign per concentration at the length-weighted centroid of all member vertices', () => {
    const areas = [
      seg('way/1', 'hiking-trail', 'Long', [
        [0, 0],
        [1000, 0],
      ]),
      seg('way/2', 'hiking-trail', 'Short', [
        [1000, 200],
        [1000, 300],
      ]),
    ];
    const plans = planSigns(areas, new Map(), new Set(), all(areas));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.east).toBeCloseTo(600000 / 1100, 9);
    expect(plans[0]?.north).toBeCloseTo(25000 / 1100, 9);
    expect(plans[0]?.label).toBe('2 trails');
    expect(plans[0]?.family).toBe('concentration');
  });

  it('separates two tracks 251 m apart and joins them at 249 m', () => {
    const make = (gap: number): Area[] => [
      seg('way/1', 'hiking-trail', 'A', [
        [0, 0],
        [100, 0],
      ]),
      seg('way/2', 'hiking-trail', 'B', [
        [100 + gap, 0],
        [500, 0],
      ]),
    ];
    expect(planSigns(make(249), new Map(), new Set(), all(make(249)))).toHaveLength(1);
    expect(planSigns(make(251), new Map(), new Set(), all(make(251)))).toHaveLength(2);
  });

  it('labels a lone track by name and counts a split track once', () => {
    const parts = [
      seg('way/1', 'hiking-trail', 'H', [
        [0, 0],
        [200, 0],
      ]),
      seg('way/2', 'hiking-trail', 'H', [
        [200, 0],
        [400, 0],
      ]),
    ];
    const plans = planSigns(parts, new Map(), new Set(), all(parts));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.label).toBe('H');
    expect(plans[0]?.trackCount).toBe(1);
    expect(planSigns(parts, new Map(), new Set(), new Set())).toHaveLength(0);
  });

  it('shows classic and skate chips together on one nordic trail, in schema order', () => {
    const trail = [
      seg('way/1', 'nordic-trail', 'Birch', [
        [0, 0],
        [400, 0],
      ]),
    ];
    const annotations = new Map([['way/1', note('way/1', ['nordic-skate', 'nordic-classic'])]]);
    const plans = planSigns(trail, annotations, new Set(), all(trail));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.activities).toEqual(['nordic-classic', 'nordic-skate']);
  });

  it('takes the union of activities across the tracks of a concentration', () => {
    const areas = [
      seg('way/1', 'nordic-trail', 'A', [
        [0, 0],
        [100, 0],
      ]),
      seg('way/2', 'mtb-trail', 'B', [
        [100, 100],
        [200, 100],
      ]),
    ];
    const annotations = new Map([
      ['way/1', note('way/1', ['nordic-classic'])],
      ['way/2', note('way/2', ['mountain-bike'])],
    ]);
    const plans = planSigns(areas, annotations, new Set(), all(areas));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.activities).toEqual(['nordic-classic', 'mountain-bike']);
  });

  it('intersects the annotation with the selected filter, and falls back to sportForArea', () => {
    const trail = [
      seg('way/1', 'nordic-trail', 'Birch', [
        [0, 0],
        [400, 0],
      ]),
      seg('way/2', 'lift', 'Chair', [
        [5000, 0],
        [5400, 0],
      ]),
    ];
    const annotations = new Map([
      ['way/1', note('way/1', ['nordic-classic', 'nordic-skate'])],
      ['way/2', note('way/2', ['lift-ride'])],
    ]);
    const plans = planSigns(trail, annotations, new Set(['nordic-skate']), all(trail));
    expect(plans.find((p) => p.label === 'Birch')?.activities).toEqual(['nordic-skate']);
    expect(plans.find((p) => p.label === 'Chair')?.activities).toEqual(['lift-ride']);
  });

  const row = (count: number, spacing: number): Area[] =>
    Array.from({ length: count }, (_, i) =>
      seg(`way/${i}`, 'hiking-trail', `T${i}`, [
        [i * spacing, 0],
        [i * spacing, 10],
      ]),
    );

  it('splits a 13-track, 2400 m concentration in two, deterministically, and not 8 tracks or 840 m', () => {
    const wide = row(13, 200);
    const first = planSigns(wide, new Map(), new Set(), all(wide));
    expect(first).toHaveLength(2);
    expect(first.reduce((s, p) => s + p.trackCount, 0)).toBeGreaterThanOrEqual(13);
    expect(planSigns(wide.slice().reverse(), new Map(), new Set(), all(wide))).toEqual(first);
    expect(first[0]?.east).toBeLessThan(first[1]?.east as number);
    const eight = row(8, 200);
    expect(planSigns(eight, new Map(), new Set(), all(eight))).toHaveLength(1);
    const tight = row(13, 70);
    expect(planSigns(tight, new Map(), new Set(), all(tight))).toHaveLength(1);
  });

  it('shows a long trail running through both halves of a split on both signs', () => {
    const areas = [
      ...row(13, 200),
      seg('way/900', 'hiking-trail', 'Superior Hiking Trail', [
        [0, 5],
        [2400, 5],
      ]),
    ];
    const plans = planSigns(areas, new Map(), new Set(), all(areas));
    expect(plans).toHaveLength(2);
    expect(plans.every((p) => p.trackCount >= 7)).toBe(true);
  });
});

describe('planTrailSigns', () => {
  const trail = (name: string | null = 'Birch'): Area[] => [
    seg('way/1', 'nordic-trail', name, [
      [0, 0],
      [800, 0],
    ]),
  ];

  it('puts one sign at the midpoint of a one-sport track', () => {
    const areas = trail();
    const annotations = new Map([['way/1', note('way/1', ['hike'])]]);
    const plans = planTrailSigns(areas, annotations, new Set(), all(areas));
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ east: 400, north: 0, family: 'trail', label: 'Birch' });
  });

  it('puts one sign at the midpoint of a four-sport track, with every sport in schema order', () => {
    const areas = trail();
    const sports: Activity[] = ['hike', 'mountain-bike', 'nordic-classic', 'nordic-skate'];
    const annotations = new Map([['way/1', note('way/1', [...sports].reverse())]]);
    const plans = planTrailSigns(areas, annotations, new Set(), all(areas));
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ east: 400, north: 0, label: 'Birch', trackCount: 1 });
    expect(plans[0]?.activities).toEqual(ActivitySchema.options.filter((a) => sports.includes(a)));
  });

  it('gives a nordic trail a classic chip and a skate chip on one sign', () => {
    const areas = trail();
    const annotations = new Map([['way/1', note('way/1', ['nordic-skate', 'nordic-classic'])]]);
    const plans = planTrailSigns(areas, annotations, new Set(), all(areas));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.activities).toEqual(['nordic-classic', 'nordic-skate']);
  });

  it('follows the filter, skips unnamed tracks and invisible areas', () => {
    const areas = trail();
    const annotations = new Map([['way/1', note('way/1', ['nordic-classic', 'nordic-skate'])]]);
    const filtered = planTrailSigns(areas, annotations, new Set(['nordic-skate']), all(areas));
    expect(filtered.map((p) => p.activities)).toEqual([['nordic-skate']]);
    expect(planTrailSigns(trail(null), annotations, new Set(), all(areas))).toHaveLength(0);
    expect(planTrailSigns(areas, annotations, new Set(), new Set())).toHaveLength(0);
  });

  it('uses route:name as the track name', () => {
    const areas = [
      {
        ...seg('way/1', 'hiking-trail', null, [
          [0, 0],
          [100, 0],
        ]),
        osmTags: { 'route:name': 'Spirit Loop' },
      } as Area,
    ];
    expect(planTrailSigns(areas, new Map(), new Set(), all(areas))[0]?.label).toBe('Spirit Loop');
  });
});

describe('mergeTrackPath and pointAlong', () => {
  it('chains segments given out of order and reversed into one path', () => {
    const areas = [
      seg('way/2', 'hiking-trail', 'T', [
        [800, 0],
        [400, 0],
      ]),
      seg('way/1', 'hiking-trail', 'T', [
        [0, 0],
        [400, 0],
      ]),
    ];
    const path = mergeTrackPath(areas);
    expect(path[0]).toEqual({ east: 0, north: 0 });
    expect(path[path.length - 1]).toEqual({ east: 800, north: 0 });
    expect(pointAlong(path, 0.25)).toEqual({ east: 200, north: 0 });
    expect(pointAlong(path, 0.75)).toEqual({ east: 600, north: 0 });
  });
});

describe('pointerVertices', () => {
  const deg = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;

  it.each([0.1, 1, 3, 10])(
    'has a vertical leg 1 and a leg 2 at 15 degrees at exaggeration %s',
    (k) => {
      const v = pointerVertices(SIGN_OFFSET_M, POINTER_ANGLE_DEG, k);
      expect(v.slice(0, 3)).toEqual([0, 0, 0]);
      // World vertices: the ElevatedGroup scales y by k and leaves x alone.
      const apex = { x: v[0], y: v[1] * k };
      const top = { x: v[3], y: v[4] * k };
      const far = { x: v[6], y: v[7] * k };
      expect(deg(apex, top)).toBeCloseTo(0, 9);
      expect(deg(apex, far)).toBeCloseTo(15, 6);
    },
  );

  it('has a top edge of length h * tan(15 degrees) at true scale', () => {
    const v = pointerVertices(25, 15, 1);
    expect(v[6]).toBeCloseTo(25 * Math.tan((15 * Math.PI) / 180), 9);
    expect(v[7]).toBe(25);
  });
});

describe('labelColorFor', () => {
  it('picks the higher-contrast of white and near-black', () => {
    expect(labelColorFor(0x000000)).toBe(0xffffff);
    expect(labelColorFor(0xffffff)).toBe(0x111111);
  });

  it.each(ActivitySchema.options)('meets 3:1 against the %s panel', (sport) => {
    const panel = SPORT_COLOR[sport];
    expect(contrastRatio(labelColorFor(panel), panel)).toBeGreaterThanOrEqual(3);
  });
});

describe('declutter', () => {
  it('keeps the nearest of two overlapping rects and every non-overlapping one', () => {
    const shown = declutter([
      { x: 0, y: 0, w: 100, h: 25, distance: 500 },
      { x: 50, y: 10, w: 100, h: 25, distance: 300 },
      { x: 300, y: 0, w: 100, h: 25, distance: 900 },
    ]);
    expect(shown).toEqual([false, true, true]);
  });

  it('breaks a tie in distance by priority, concentration (0) before trail (1), whatever the input order', () => {
    const trailFirst = declutter([
      { x: 0, y: 0, w: 100, h: 25, distance: 300, priority: 1 },
      { x: 50, y: 0, w: 100, h: 25, distance: 300, priority: 0 },
    ]);
    expect(trailFirst).toEqual([false, true]);
    const concentrationFirst = declutter([
      { x: 0, y: 0, w: 100, h: 25, distance: 300, priority: 0 },
      { x: 50, y: 0, w: 100, h: 25, distance: 300, priority: 1 },
    ]);
    expect(concentrationFirst).toEqual([true, false]);
  });

  it('places every concentration rect before any trail rect, even a farther one over a nearer one', () => {
    const shown = declutter([
      { x: 0, y: 0, w: 100, h: 25, distance: 100, priority: 1 },
      { x: 50, y: 0, w: 100, h: 25, distance: 900, priority: 0 },
      { x: 400, y: 0, w: 100, h: 25, distance: 50, priority: 1 },
    ]);
    expect(shown).toEqual([false, true, true]);
  });

  it('keeps the nearest of two overlapping rects of the same priority', () => {
    const shown = declutter([
      { x: 0, y: 0, w: 100, h: 25, distance: 500, priority: 0 },
      { x: 50, y: 0, w: 100, h: 25, distance: 300, priority: 0 },
    ]);
    expect(shown).toEqual([false, true]);
  });

  it('lets a hidden rect occlude nothing', () => {
    // B overlaps A (nearer) and C; A does not overlap C, so C stays.
    const shown = declutter([
      { x: 0, y: 0, w: 100, h: 25, distance: 100 },
      { x: 90, y: 0, w: 100, h: 25, distance: 200 },
      { x: 180, y: 0, w: 100, h: 25, distance: 300 },
    ]);
    expect(shown).toEqual([true, false, true]);
  });
});

describe('signWidthPx', () => {
  it('is 78 at 390 px and 160 at 1440 px', () => {
    expect(signWidthPx(390)).toBe(78);
    expect(signWidthPx(1440)).toBe(160);
  });
});

describe('signGlyph', () => {
  it.each(ActivitySchema.options)('returns a symbol and label for %s', (activity) => {
    const glyph = signGlyph(activity);
    expect(glyph.symbol).toMatch(/^[a-z0-9_]+$/);
    expect(glyph.label.length).toBeGreaterThan(0);
  });
});

interface Call {
  readonly op: string;
  readonly fillStyle: string;
  readonly globalAlpha: number;
  readonly font: string;
  readonly text?: string;
  readonly y?: number;
}

function recordingContext(): SignContext2D & { calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    calls,
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    record(op: string, text?: string, y?: number) {
      calls.push({
        op,
        fillStyle: String(ctx.fillStyle),
        globalAlpha: ctx.globalAlpha,
        font: ctx.font,
        ...(text === undefined ? {} : { text }),
        ...(y === undefined ? {} : { y }),
      });
    },
    clearRect() {},
    beginPath() {},
    moveTo() {},
    arc() {},
    arcTo() {},
    closePath() {},
    fill() {
      ctx.record('fill');
    },
    fillText(text: string, _x: number, y: number) {
      ctx.record('fillText', text, y);
    },
    measureText(text: string) {
      return { width: text.length * 10 };
    },
  };
  return ctx;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

describe('drawSign', () => {
  it('draws a dark neutral concentration panel at 0.9 alpha, then one chip per activity in ActivitySchema order', () => {
    const ctx = recordingContext();
    // Deliberately out of order: the chips must follow ActivitySchema.options, not the input.
    drawSign(ctx, {
      activities: ['nordic-skate', 'nordic-classic'],
      label: 'Birch Loop',
      family: 'concentration',
      glyph: true,
      width: 512,
      height: 128,
    });
    const fills = ctx.calls.filter((c) => c.op === 'fill');
    expect(fills.map((f) => f.fillStyle)).toEqual([
      hex(SIGN_PANEL_COLOR),
      hex(SPORT_COLOR['nordic-classic']),
      hex(SPORT_COLOR['nordic-skate']),
    ]);
    expect(fills[0]?.globalAlpha).toBeCloseTo(0.9, 9);
    const glyphs = ctx.calls.filter(
      (c) => c.op === 'fillText' && c.font.includes('Material Symbols'),
    );
    expect(glyphs.map((g) => g.text)).toEqual([
      signGlyph('nordic-classic').symbol,
      signGlyph('nordic-skate').symbol,
    ]);
    expect(glyphs[0]?.fillStyle).toBe(hex(labelColorFor(SPORT_COLOR['nordic-classic'])));
  });

  it('draws no start or end glyph and the label in white on a concentration sign', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      activities: ['hike'],
      label: '2 trails',
      family: 'concentration',
      glyph: true,
      width: 512,
      height: 128,
    });
    const symbols = ctx.calls.filter((c) => c.font.includes('Material Symbols'));
    expect(symbols).toHaveLength(1);
    const labelCall = ctx.calls.find((c) => c.op === 'fillText' && c.text === '2 trails');
    expect(labelCall?.fillStyle).toBe(hex(LABEL_LIGHT));
    expect(labelCall?.font).not.toContain('Material Symbols');
  });

  it('draws a trail sign on the dark panel: the bold name first, then one chip per sport in schema order', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      activities: ['nordic-skate', 'nordic-classic'],
      label: 'Superior Hiking Trail',
      family: 'trail',
      glyph: true,
      width: 512,
      height: 128,
    });
    const fills = ctx.calls.filter((c) => c.op === 'fill');
    expect(fills.map((f) => f.fillStyle)).toEqual([
      hex(SIGN_PANEL_COLOR),
      hex(SPORT_COLOR['nordic-classic']),
      hex(SPORT_COLOR['nordic-skate']),
    ]);
    const texts = ctx.calls.filter((c) => c.op === 'fillText');
    expect(texts.map((t) => t.text)).toEqual([
      'Superior Hiking Trail',
      signGlyph('nordic-classic').symbol,
      signGlyph('nordic-skate').symbol,
    ]);
    expect(texts[0]?.font).toContain('bold');
    expect(texts[0]?.fillStyle).toBe(hex(LABEL_LIGHT));
    expect(texts[1]?.font).toContain('Material Symbols');
  });

  it('keeps the trail name above the chip row', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      activities: ['hike'],
      label: 'Birch',
      family: 'trail',
      glyph: true,
      width: 512,
      height: 128,
    });
    const texts = ctx.calls.filter((c) => c.op === 'fillText');
    expect(Number(texts[0]?.y)).toBeLessThan(Number(texts[1]?.y));
  });

  it('omits every glyph when glyph is false but keeps the chips and the label', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      activities: ['hike'],
      label: 'Hike',
      family: 'concentration',
      glyph: false,
      width: 512,
      height: 128,
    });
    expect(ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.text)).toEqual(['Hike']);
    expect(ctx.calls.filter((c) => c.op === 'fill')).toHaveLength(2);
  });

  it('keys a texture by family, activities and label', () => {
    const a = { activities: ['hike'] as Activity[], label: 'x', family: 'trail' as const };
    expect(signTextureKey(a)).toBe(signTextureKey({ ...a }));
    expect(signTextureKey(a)).not.toBe(signTextureKey({ ...a, family: 'concentration' }));
    expect(signTextureKey(a)).not.toBe(signTextureKey({ ...a, label: 'y' }));
  });
});

describe('loadSignFont', () => {
  it('returns false and warns once when fonts is undefined', async () => {
    const warn = vi.fn();
    expect(await loadSignFont(undefined, ['hiking', 'pedal_bike'], warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns false and warns once when load rejects', async () => {
    const warn = vi.fn();
    const fonts = { load: vi.fn(() => Promise.reject(new Error('offline'))) };
    expect(await loadSignFont(fonts, ['hiking', 'pedal_bike'], warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('loads every symbol with the Material Symbols font and returns true', async () => {
    const warn = vi.fn();
    const fonts = { load: vi.fn(() => Promise.resolve([{}])) };
    expect(await loadSignFont(fonts, ['hiking', 'pedal_bike'], warn)).toBe(true);
    expect(fonts.load).toHaveBeenCalledWith('24px "Material Symbols Outlined"', 'hiking');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('fade', () => {
  it('is 1 at 4000 m, 0 at 10100 m and strictly between at a mid value', () => {
    expect(fadeAlpha(4000)).toBe(1);
    expect(fadeAlpha(10100)).toBe(0);
    const mid = fadeAlpha(7000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

// ---- the three layer ----

const surface: MeshSurface = createMeshSurface(makeFixtureField(), 16);
const mapper: SceneMapper = (east, north, elevation) => [east, elevation, -north];

const lineArea = (
  id: string,
  kind: Area['kind'],
  east: number,
  north: number,
  name: string | null = null,
): Area =>
  ({
    id,
    kind,
    name,
    osmTags: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [east - 10, north, 0],
        [east + 10, north, 0],
      ],
    },
  }) as unknown as Area;

// Unnamed, so each is one concentration sign and no trail-sport sign.
const AREAS: Area[] = [
  lineArea('way/1', 'mtb-trail', 0, 0),
  lineArea('way/2', 'mtb-trail', 400, 0),
  lineArea('way/3', 'downhill-run', -200, 200),
  lineArea('way/4', 'lift', 200, -200),
];

function fakeCanvas(): SignCanvas {
  const ctx = recordingContext();
  return { width: 0, height: 0, getContext: () => ctx };
}

function makeHost(): BillboardFrameHost & {
  callback: ((deltaMs: number) => void) | null;
  unsubscribe: ReturnType<typeof vi.fn>;
  k: number;
} {
  const camera = new PerspectiveCamera(50, 1200 / 800, 1, 50000);
  // Overhead at 1500 m: the fixture signs are about 280 x 70 m on screen and do not overlap, so none is decluttered.
  camera.position.set(0, 1500, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const unsubscribe = vi.fn();
  const host = {
    camera,
    renderer: { domElement: { clientWidth: 1200, clientHeight: 800 } },
    k: 1,
    get exaggeration() {
      return host.k;
    },
    callback: null as ((deltaMs: number) => void) | null,
    unsubscribe,
    onFrame(cb: (deltaMs: number) => void) {
      host.callback = cb;
      return unsubscribe;
    },
  };
  return host;
}

function build(host = makeHost(), areas: readonly Area[] = AREAS) {
  const layer = buildBillboardLayer(areas, surface, mapper, {
    host,
    fadeCentre: { east: 0, north: 0 },
    createCanvas: fakeCanvas,
    fonts: undefined,
    warn: () => {},
  });
  return { layer, host };
}

const sprites = (group: { traverse: (f: (o: unknown) => void) => void }): Sprite[] => {
  const out: Sprite[] = [];
  group.traverse((o) => {
    if (o instanceof Sprite) out.push(o);
  });
  return out;
};
const visibleSprites = (group: Parameters<typeof sprites>[0]): Sprite[] =>
  sprites(group).filter((s) => s.visible);

const ALL_IDS = new Set(AREAS.map((a) => a.id));
const NO_ANNOTATIONS = new Map<string, Annotation>();

describe('buildBillboardLayer', () => {
  it('shows one concentration sign per unnamed track on first build, the lift included', () => {
    const { layer } = build();
    expect(visibleSprites(layer.group)).toHaveLength(4);
    const stats = layer.stats();
    expect(stats.clusterCount).toBe(4);
    expect(stats.concentrationCount).toBe(4);
    expect(stats.trailCount).toBe(0);
    expect(stats.perSport['lift-ride']).toBe(1);
    expect(stats.perSport['mountain-bike']).toBe(2);
  });

  it('builds each sign as a bottom-centre-anchored sprite directly in the layer group', () => {
    const { layer } = build();
    const sprite = visibleSprites(layer.group)[0] as Sprite;
    expect(sprite.center.x).toBe(0.5);
    expect(sprite.center.y).toBe(0);
    expect(sprite.parent).toBe(layer.group);
    expect(layer.group.children.every((c) => c instanceof Sprite)).toBe(true);
  });

  it('draws the panel with no depth test after every default-order object', () => {
    const { layer } = build();
    const sprite = visibleSprites(layer.group)[0] as Sprite;
    expect(sprite.material.depthTest).toBe(false);
    expect(sprite.material.depthWrite).toBe(false);
    expect(sprite.renderOrder).toBe(SIGN_RENDER_ORDER);
  });

  it('yields zero visible signs for an empty visibleIds', () => {
    const { layer } = build();
    layer.applyFilter(NO_ANNOTATIONS, new Set(), new Set());
    expect(visibleSprites(layer.group)).toHaveLength(0);
  });

  it('follows the activity filter through visibleIds', () => {
    const { layer } = build();
    layer.applyFilter(NO_ANNOTATIONS, new Set(['mountain-bike']), new Set(['way/1', 'way/2']));
    const visible = visibleSprites(layer.group);
    expect(visible).toHaveLength(2);
    expect(visible[0]?.userData['activities']).toEqual(['mountain-bike']);
    layer.applyFilter(NO_ANNOTATIONS, new Set(), ALL_IDS);
    expect(visibleSprites(layer.group)).toHaveLength(4);
  });

  it('reuses sprites by index across filter changes', () => {
    const { layer } = build();
    const before = sprites(layer.group).length;
    layer.applyFilter(NO_ANNOTATIONS, new Set(), new Set(['way/3']));
    layer.applyFilter(NO_ANNOTATIONS, new Set(), ALL_IDS);
    expect(sprites(layer.group).length).toBe(before);
  });

  it('sits at the active surface height at the centroid plus 25 m and follows redrape', () => {
    const { layer } = build();
    const sign = sprites(layer.group).find(
      (s) => (s.userData['activities'] as Activity[])[0] === 'alpine-ski',
    ) as Sprite;
    const worldY = (): number => sign.getWorldPosition(new Vector3()).y;
    const ground = surface.sample(-200, 200).height;
    expect(worldY()).toBeCloseTo(ground + SIGN_OFFSET_M, 6);
    const raised: MeshSurface = {
      ...surface,
      sample: (e, n) => {
        const s = surface.sample(e, n);
        return { ...s, height: s.height + 40 };
      },
    };
    layer.redrape(raised);
    expect(worldY()).toBeCloseTo(ground + 40 + SIGN_OFFSET_M, 6);
    layer.redrape(surface);
    expect(worldY()).toBeCloseTo(ground + SIGN_OFFSET_M, 6);
  });

  const FOUR_SPORT: Area[] = [
    {
      ...lineArea('way/9', 'hiking-trail', 0, 0, 'Birch Loop'),
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0, 0],
          [800, 0, 0],
        ],
      },
    } as unknown as Area,
  ];
  const FOUR_NOTES = new Map([
    ['way/9', note('way/9', ['hike', 'mountain-bike', 'nordic-classic', 'nordic-skate'])],
  ]);

  const trailSprites = (group: Parameters<typeof sprites>[0]): Sprite[] =>
    sprites(group).filter((s) => s.userData['family'] === 'trail' && s.visible);

  it('shows one trail sign carrying all four sports on a named 4-sport track, at its midpoint', () => {
    const { layer } = build(makeHost(), FOUR_SPORT);
    layer.applyFilter(FOUR_NOTES, new Set(), new Set(['way/9']));
    const stats = layer.stats();
    expect(stats.concentrationCount).toBe(1);
    expect(stats.trailCount).toBe(1);
    const trail = trailSprites(layer.group);
    expect(trail).toHaveLength(1);
    const sprite = trail[0] as Sprite;
    expect(sprite.userData['activities']).toEqual(
      ActivitySchema.options.filter((a) =>
        ['hike', 'mountain-bike', 'nordic-classic', 'nordic-skate'].includes(a),
      ),
    );
    expect(sprite.userData['label']).toBe('Birch Loop');
    // Bottom-left anchored, lifted SIGN_OFFSET_M above the trail point at (400, 0) on the surface.
    expect(sprite.center.x).toBe(0);
    expect(sprite.center.y).toBe(0);
    const world = sprite.getWorldPosition(new Vector3());
    expect(world.x).toBeCloseTo(400, 6);
    expect(world.y).toBeCloseTo(surface.sample(400, 0).height + SIGN_OFFSET_M, 6);
  });

  it('puts the pointer apex on the trail point and leaves concentration signs without one', () => {
    const { layer } = build(makeHost(), FOUR_SPORT);
    layer.applyFilter(FOUR_NOTES, new Set(), new Set(['way/9']));
    const pointers: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh) pointers.push(o);
    });
    const visible = pointers.filter((p) => p.visible);
    expect(visible).toHaveLength(1);
    const pointer = visible[0] as Mesh;
    expect((pointer.material as MeshBasicMaterial).color.getHex()).toBe(SIGN_PANEL_COLOR);
    const apex = pointer.localToWorld(new Vector3(0, 0, 0));
    expect(apex.x).toBeCloseTo(400, 6);
    expect(apex.y).toBeCloseTo(surface.sample(400, 0).height, 6);
    const concentration = sprites(layer.group).find(
      (s) => s.userData['family'] === 'concentration',
    );
    expect(concentration?.center.x).toBe(0.5);
    expect(concentration?.parent).toBe(layer.group);
  });

  it('keeps leg 2 at 15 degrees in the world as the exaggeration changes', () => {
    const host = makeHost();
    const { layer } = build(host, FOUR_SPORT);
    layer.applyFilter(FOUR_NOTES, new Set(), new Set(['way/9']));
    const elevated = new ElevatedGroup();
    elevated.add(layer.group);
    const pointer = trailSprites(layer.group)[0]?.parent?.children.find(
      (c) => c instanceof Mesh,
    ) as Mesh;
    for (const k of [0.1, 1, 10]) {
      host.k = k;
      elevated.setExaggeration(k, 0);
      host.callback?.(16);
      const pos = pointer.geometry.getAttribute('position');
      const apex = new Vector3().fromBufferAttribute(pos, 0);
      const top = new Vector3().fromBufferAttribute(pos, 1);
      const far = new Vector3().fromBufferAttribute(pos, 2);
      // Local x is unscaled by the group; local y is scaled by effectiveScale(k).
      expect(top.x - apex.x).toBeCloseTo(0, 9);
      expect(Math.atan2(far.x - apex.x, (far.y - apex.y) * effectiveScale(k))).toBeCloseTo(
        (POINTER_ANGLE_DEG * Math.PI) / 180,
        6,
      );
    }
  });

  it('compensates the group exaggeration: scale.y * effectiveScale(k) is constant', () => {
    const host = makeHost();
    const { layer } = build(host);
    const elevated = new ElevatedGroup();
    elevated.add(layer.group);
    const sign = visibleSprites(layer.group)[0] as Sprite;
    const products: number[] = [];
    const worldX: number[] = [];
    for (const k of [0.1, 1, 10]) {
      host.k = k;
      // Same camera distance each time: pin the camera relative to the sign's world position.
      elevated.setExaggeration(k, sign.position.y);
      const p = sign.getWorldPosition(new Vector3());
      host.camera.position.set(p.x, p.y + 1000, p.z + 2000);
      host.camera.updateMatrixWorld(true);
      host.callback?.(16);
      products.push(sign.scale.y * effectiveScale(k));
      worldX.push(sign.scale.x);
    }
    for (const value of products) expect(value).toBeCloseTo(products[0] as number, 6);
    for (const value of worldX) expect(value).toBeCloseTo(worldX[0] as number, 6);
  });

  it('sizes the sign to signWidthPx in screen space', () => {
    const host = makeHost();
    const { layer } = build(host);
    host.callback?.(16);
    const sign = visibleSprites(layer.group)[0] as Sprite;
    // View-space depth, not Euclidean distance: an off-axis sign at the same depth has the same pixel size.
    const d = -sign.getWorldPosition(new Vector3()).applyMatrix4(host.camera.matrixWorldInverse).z;
    expect(d).not.toBeCloseTo(
      host.camera.position.distanceTo(sign.getWorldPosition(new Vector3())),
      1,
    );
    const worldPerPx = (2 * d * Math.tan(((host.camera.fov / 2) * Math.PI) / 180)) / 800;
    expect(sign.scale.x).toBeCloseTo(signWidthPx(1200) * worldPerPx, 6);
  });

  it('declutters overlapping signs, keeping the nearest', () => {
    const host = makeHost();
    const { layer } = build(host);
    // Far and oblique: every sign is wider on screen than the gaps between them.
    host.camera.position.set(0, 3000, 6000);
    host.camera.up.set(0, 1, 0);
    host.camera.lookAt(0, 0, 0);
    host.camera.updateMatrixWorld(true);
    host.callback?.(16);
    expect(layer.stats().clusterCount).toBe(4);
    expect(visibleSprites(layer.group).length).toBeLessThan(4);
    expect(layer.stats().shownCount).toBe(visibleSprites(layer.group).length);
  });

  it('hides a sign beyond the fade outer radius', () => {
    const host = makeHost();
    const layer = buildBillboardLayer(AREAS, surface, mapper, {
      host,
      fadeCentre: { east: 20000, north: 0 },
      createCanvas: fakeCanvas,
      fonts: undefined,
      warn: () => {},
    });
    host.callback?.(16);
    expect(visibleSprites(layer.group)).toHaveLength(0);
  });

  it('dispose releases textures and materials and unsubscribes', () => {
    const { layer, host } = build();
    const spies: Array<ReturnType<typeof vi.spyOn>> = [];
    const textures = new Set<{ dispose: () => void }>();
    layer.group.traverse((o) => {
      if (o instanceof Sprite) {
        spies.push(vi.spyOn(o.material, 'dispose'));
        if (o.material.map) textures.add(o.material.map);
      }
    });
    for (const texture of textures) spies.push(vi.spyOn(texture, 'dispose'));
    expect(textures.size).toBe(3); // the two mountain-bike signs share one texture
    layer.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

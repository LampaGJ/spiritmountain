import { Mesh, MeshBasicMaterial, PerspectiveCamera, Sprite, Vector3, type Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fadeAlpha } from '../../scripts/ingest/context-tiles';
import { GHOST_RENDER_ORDER, type SceneMapper } from '../../src/scene/areas';
import {
  areaCentroid,
  buildBillboardLayer,
  clusterAreas,
  contrastRatio,
  declutter,
  drawSign,
  labelColorFor,
  lineCentroid,
  loadSignFont,
  planSigns,
  pointerVertices,
  polygonCentroid,
  signTextureKey,
  signWidthPx,
  LABEL_LIGHT,
  SIGN_PANEL_COLOR,
  trackEnds,
  POINTER_ANGLE_DEG,
  SIGN_OFFSET_M,
  type BillboardFrameHost,
  type ClusterInput,
  type SignCanvas,
  type SignContext2D,
} from '../../src/scene/billboards';
import { ElevatedGroup, effectiveScale } from '../../src/scene/elevated';
import { createMeshSurface, type MeshSurface } from '../../src/scene/heightfield';
import { SPORT_COLOR } from '../../src/scene/palette';
import type { Activity } from '../../src/scene/sport-routing';
import { ActivitySchema, type Annotation } from '../../src/schema/annotation';
import type { Area } from '../../src/schema/area';
import { iconFor, signGlyph } from '../../src/ui/icons';
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

const uphillEast = (east: number): number => east;

describe('trackEnds', () => {
  const chain = [
    seg('way/1', 'mtb-trail', 'T', [
      [0, 0],
      [100, 0],
    ]),
    seg('way/2', 'mtb-trail', 'T', [
      [103, 2],
      [200, 0],
    ]),
    seg('way/3', 'mtb-trail', 'T', [
      [200, 0],
      [300, 0],
    ]),
  ];

  it('treats an endpoint within 5 m of another segment as a junction, not a free end', () => {
    const ends = trackEnds(chain, uphillEast);
    expect(ends.start).toEqual({ east: 300, north: 0 });
    expect(ends.end).toEqual({ east: 0, north: 0 });
  });

  it('puts START at the highest free endpoint and END at the lowest', () => {
    const flipped = trackEnds(chain, (east) => -east);
    expect(flipped.start).toEqual({ east: 0, north: 0 });
    expect(flipped.end).toEqual({ east: 300, north: 0 });
  });

  it('gives a loop one START at the first vertex of its smallest-id segment and no END', () => {
    const loop = [
      seg('way/9', 'nordic-trail', 'L', [
        [500, 0],
        [0, 0],
      ]),
      seg('way/2', 'nordic-trail', 'L', [
        [0, 0],
        [250, 300],
        [500, 0],
      ]),
    ];
    expect(trackEnds(loop, uphillEast)).toEqual({ start: { east: 0, north: 0 }, end: null });
    const closedWay = [
      seg('way/1', 'nordic-trail', 'C', [
        [10, 10],
        [200, 10],
        [10, 10],
      ]),
    ];
    expect(trackEnds(closedWay, uphillEast)).toEqual({ start: { east: 10, north: 10 }, end: null });
  });

  it('drops an END within 150 m of the START and keeps one at 151 m', () => {
    const short = [
      seg('way/1', 'mtb-trail', 'S', [
        [0, 0],
        [150, 0],
      ]),
    ];
    expect(trackEnds(short, uphillEast).end).toBeNull();
    const long = [
      seg('way/1', 'mtb-trail', 'S', [
        [0, 0],
        [151, 0],
      ]),
    ];
    expect(trackEnds(long, uphillEast).end).not.toBeNull();
  });

  it('puts a polygon-only track at its centroid', () => {
    const park = {
      id: 'way/5',
      kind: 'snow-park',
      name: 'Park',
      osmTags: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0, 0],
            [10, 0, 0],
            [10, 10, 0],
            [0, 10, 0],
            [0, 0, 0],
          ],
        ],
      },
    } as unknown as Area;
    expect(trackEnds([park], uphillEast)).toEqual({ start: { east: 5, north: 5 }, end: null });
  });
});

describe('planSigns', () => {
  const all = (areas: readonly Area[]): Set<string> => new Set(areas.map((a) => a.id));

  it('yields exactly 2 signs for a 47-segment trail', () => {
    const sht = Array.from({ length: 47 }, (_, i) =>
      seg(`way/${100 + i}`, 'hiking-trail', 'Superior Hiking Trail', [
        [i * 100, 0],
        [(i + 1) * 100, 0],
      ]),
    );
    const annotations = new Map(sht.map((a) => [a.id, note(a.id, ['hike'])]));
    const plans = planSigns(sht, annotations, new Set(), all(sht), uphillEast);
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.role).sort()).toEqual(['end', 'start']);
    expect(plans.every((p) => p.label === 'Superior Hiking Trail' && p.trackCount === 1)).toBe(
      true,
    );
  });

  it('shows classic and skate chips together on one nordic trail, in schema order', () => {
    const trail = [
      seg('way/1', 'nordic-trail', 'Birch', [
        [0, 0],
        [400, 0],
      ]),
    ];
    const annotations = new Map([['way/1', note('way/1', ['nordic-skate', 'nordic-classic'])]]);
    const plans = planSigns(trail, annotations, new Set(), all(trail), uphillEast);
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.activities).toEqual(['nordic-classic', 'nordic-skate']);
  });

  it('intersects the annotation with the selected filter, and falls back to sportForArea', () => {
    const trail = [
      seg('way/1', 'nordic-trail', 'Birch', [
        [0, 0],
        [400, 0],
      ]),
      seg('way/2', 'lift', 'Chair', [
        [1000, 0],
        [1400, 0],
      ]),
    ];
    const annotations = new Map([
      ['way/1', note('way/1', ['nordic-classic', 'nordic-skate'])],
      ['way/2', note('way/2', ['lift-ride'])],
    ]);
    const plans = planSigns(trail, annotations, new Set(['nordic-skate']), all(trail), uphillEast);
    const birch = plans.filter((p) => p.label === 'Birch');
    const chair = plans.filter((p) => p.label === 'Chair');
    for (const p of birch) expect(p.activities).toEqual(['nordic-skate']);
    for (const p of chair) expect(p.activities).toEqual(['lift-ride']);
  });

  it('merges signs within 60 m into one carrying the union of activities, and splits at 61 m', () => {
    const make = (gap: number): Area[] => [
      seg('way/1', 'nordic-trail', 'A', [
        [0, 0],
        [400, 0],
      ]),
      seg('way/2', 'mtb-trail', 'B', [
        [400 + gap, 0],
        [900, 0],
      ]),
    ];
    const notes = (areas: Area[]): Map<string, Annotation> =>
      new Map([
        [areas[0]?.id as string, note('way/1', ['nordic-classic'])],
        [areas[1]?.id as string, note('way/2', ['mountain-bike'])],
      ]);
    const near = make(60);
    const merged = planSigns(near, notes(near), new Set(), all(near), uphillEast).filter(
      (p) => p.trackCount === 2,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.activities).toEqual(['nordic-classic', 'mountain-bike']);
    expect(merged[0]?.label).toBe('2 trails');
    const far = make(61);
    expect(
      planSigns(far, notes(far), new Set(), all(far), uphillEast).filter((p) => p.trackCount === 2),
    ).toHaveLength(0);
  });

  it('counts a split track once and ignores areas that are not visible', () => {
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
    expect(planSigns(parts, new Map(), new Set(), all(parts), uphillEast)).toHaveLength(2);
    expect(planSigns(parts, new Map(), new Set(), new Set(), uphillEast)).toHaveLength(0);
  });
});

describe('pointerVertices', () => {
  const angleOf = (v: number[], yScale: number): { leg1: number; leg2: number } => {
    // World vertices: the ElevatedGroup scales y by yScale and leaves x alone.
    const p = [0, 3, 6].map((i) => ({ x: v[i] as number, y: (v[i + 1] as number) * yScale }));
    const [apex, top, far] = p as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const deg = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return { leg1: deg(apex, top), leg2: deg(apex, far) };
  };

  it.each([0.1, 1, 3, 10])(
    'has a vertical leg 1 and a leg 2 at 15 degrees at exaggeration %s',
    (k) => {
      const v = pointerVertices(SIGN_OFFSET_M, POINTER_ANGLE_DEG, k);
      expect(v.slice(0, 3)).toEqual([0, 0, 0]);
      const { leg1, leg2 } = angleOf(v, k);
      expect(leg1).toBeCloseTo(0, 9);
      expect(leg2).toBeCloseTo(15, 6);
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
    record(op: string, text?: string) {
      calls.push({
        op,
        fillStyle: String(ctx.fillStyle),
        globalAlpha: ctx.globalAlpha,
        font: ctx.font,
        ...(text === undefined ? {} : { text }),
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
    fillText(text: string) {
      ctx.record('fillText', text);
    },
    measureText(text: string) {
      return { width: text.length * 10 };
    },
  };
  return ctx;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

describe('drawSign', () => {
  it('draws a dark neutral panel at 0.9 alpha, then one chip per activity in ActivitySchema order', () => {
    const ctx = recordingContext();
    // Deliberately out of order: the chips must follow ActivitySchema.options, not the input.
    drawSign(ctx, {
      activities: ['nordic-skate', 'nordic-classic'],
      label: 'Birch Loop',
      role: 'start',
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
      iconFor('track-start').symbol,
    ]);
    expect(glyphs[0]?.fillStyle).toBe(hex(labelColorFor(SPORT_COLOR['nordic-classic'])));
  });

  it('shows the end glyph for an END and the label in white', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      activities: ['hike'],
      label: '2 trails',
      role: 'end',
      glyph: true,
      width: 512,
      height: 128,
    });
    expect(
      ctx.calls.some((c) => c.op === 'fillText' && c.text === iconFor('track-end').symbol),
    ).toBe(true);
    const labelCall = ctx.calls.find((c) => c.op === 'fillText' && c.text === '2 trails');
    expect(labelCall?.fillStyle).toBe(hex(LABEL_LIGHT));
    expect(labelCall?.font).not.toContain('Material Symbols');
  });

  it('omits every glyph when glyph is false but keeps the chips and the label', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      activities: ['hike'],
      label: 'Hike',
      role: 'start',
      glyph: false,
      width: 512,
      height: 128,
    });
    expect(ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.text)).toEqual(['Hike']);
    expect(ctx.calls.filter((c) => c.op === 'fill')).toHaveLength(2);
  });

  it('keys a texture by activities, label and role', () => {
    const a = { activities: ['hike'] as Activity[], label: 'x', role: 'start' as const };
    expect(signTextureKey(a)).toBe(signTextureKey({ ...a }));
    expect(signTextureKey(a)).not.toBe(signTextureKey({ ...a, role: 'end' }));
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

const lineArea = (id: string, kind: Area['kind'], east: number, north: number): Area =>
  ({
    id,
    kind,
    name: id,
    osmTags: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [east - 10, north, 0],
        [east + 10, north, 0],
      ],
    },
  }) as unknown as Area;

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
  // Overhead at 1500 m: the three fixture signs are about 280 x 70 m on screen and do not overlap, so none is decluttered.
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

function build(host = makeHost()) {
  const layer = buildBillboardLayer(AREAS, surface, mapper, {
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
  it('shows one sign per track on first build (each fixture track is too short for an END), the lift included', () => {
    const { layer } = build();
    // Four named tracks of 20 m: one START each; the END is within 150 m and dropped.
    expect(visibleSprites(layer.group)).toHaveLength(4);
    expect(layer.stats().clusterCount).toBe(4);
    expect(layer.stats().perSport['lift-ride']).toBe(1);
    expect(layer.stats().perSport['mountain-bike']).toBe(2);
  });

  it('builds each sign as one rigid group: a pointer and a bottom-left-anchored sprite under one parent', () => {
    const { layer } = build();
    const sprite = visibleSprites(layer.group)[0] as Sprite;
    expect(sprite.center.x).toBe(0);
    expect(sprite.center.y).toBe(0);
    const rigid = sprite.parent as Object3D;
    expect(rigid.parent).toBe(layer.group);
    expect(rigid.children).toHaveLength(2);
    expect(rigid.children.some((c) => c instanceof Mesh)).toBe(true);
    expect(sprite.position.x).toBe(0);
    expect(sprite.position.y).toBe(SIGN_OFFSET_M);
  });

  it('yaws the pointer group toward the camera each frame', () => {
    const host = makeHost();
    const { layer } = build(host);
    host.camera.position.set(3000, 1500, 0);
    host.camera.lookAt(0, 0, 0);
    host.camera.updateMatrixWorld(true);
    host.callback?.(16);
    const rigid = (sprites(layer.group)[0] as Sprite).parent as Object3D;
    const expected = Math.atan2(3000 - rigid.position.x, 0 - rigid.position.z);
    expect(rigid.rotation.y).toBeCloseTo(expected, 9);
  });

  it('keeps leg 2 at 15 degrees in the world as the exaggeration changes', () => {
    const host = makeHost();
    const { layer } = build(host);
    const elevated = new ElevatedGroup();
    elevated.add(layer.group);
    const rigid = (sprites(layer.group)[0] as Sprite).parent as Object3D;
    const pointer = rigid.children.find((c) => c instanceof Mesh) as Mesh;
    for (const k of [0.1, 1, 10]) {
      host.k = k;
      elevated.setExaggeration(k, 0);
      host.callback?.(16);
      const pos = pointer.geometry.getAttribute('position');
      const apex = new Vector3().fromBufferAttribute(pos, 0);
      const top = new Vector3().fromBufferAttribute(pos, 1);
      const far = new Vector3().fromBufferAttribute(pos, 2);
      // Un-yawed group: world vertex = (x, y * scale, z) relative to the apex.
      expect(top.x - apex.x).toBeCloseTo(0, 9);
      expect(Math.atan2(far.x - apex.x, (far.y - apex.y) * effectiveScale(k))).toBeCloseTo(
        (POINTER_ANGLE_DEG * Math.PI) / 180,
        6,
      );
    }
  });

  it('draws the panel with no depth test above the ghost pass, and a depth-tested tapered pointer', () => {
    const { layer } = build();
    const sprite = visibleSprites(layer.group)[0] as Sprite;
    expect(sprite.material.depthTest).toBe(false);
    expect(sprite.material.depthWrite).toBe(false);
    expect(sprite.renderOrder).toBe(GHOST_RENDER_ORDER + 1);
    const pointers: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh && o.name.startsWith('billboard-pointer')) pointers.push(o);
    });
    expect(pointers.length).toBeGreaterThan(0);
    const first = pointers[0] as Mesh;
    expect((first.material as MeshBasicMaterial).depthTest).toBe(true);
    expect(first.geometry.getAttribute('position').count).toBe(3);
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

  it('reuses sprites by index within a sport across filter changes', () => {
    const { layer } = build();
    const before = sprites(layer.group).length;
    layer.applyFilter(NO_ANNOTATIONS, new Set(), new Set(['way/3']));
    layer.applyFilter(NO_ANNOTATIONS, new Set(), ALL_IDS);
    expect(sprites(layer.group).length).toBe(before);
  });

  it('sits at the active surface height plus 25 m and follows redrape', () => {
    const { layer } = build();
    const sign = sprites(layer.group).find(
      (s) => (s.userData['activities'] as Activity[])[0] === 'alpine-ski',
    ) as Sprite;
    const worldY = (): number => sign.getWorldPosition(new Vector3()).y;
    // The sign stands on the track's START: the higher of the 20 m line's two ends.
    const ground = Math.max(surface.sample(-210, 200).height, surface.sample(-190, 200).height);
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

  it('re-picks START and END from the new surface on redrape', () => {
    const track = seg('way/1', 'nordic-trail', 'Long', [
      [0, 0],
      [400, 0],
    ]);
    const host = makeHost();
    const layer = buildBillboardLayer([track], surface, mapper, {
      host,
      fadeCentre: { east: 0, north: 0 },
      createCanvas: fakeCanvas,
      fonts: undefined,
      warn: () => {},
    });
    const startEast = (): number => {
      const start = sprites(layer.group).find((s) => s.userData['role'] === 'start') as Sprite;
      return (start.parent as Object3D).position.x;
    };
    layer.redrape({ ...surface, sample: (e) => ({ ...surface.sample(e, 0), height: e }) });
    expect(startEast()).toBeCloseTo(400, 6);
    layer.redrape({ ...surface, sample: (e) => ({ ...surface.sample(e, 0), height: -e }) });
    expect(startEast()).toBeCloseTo(0, 6);
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
      // Same camera distance each time: keep the sign's world position fixed by moving nothing but k at base 0
      // would move it; so pin the camera relative to the sign's world position.
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

  it('dispose releases textures, materials, geometries and unsubscribes', () => {
    const { layer, host } = build();
    const spies: Array<ReturnType<typeof vi.spyOn>> = [];
    const textures = new Set<{ dispose: () => void }>();
    layer.group.traverse((o) => {
      if (o instanceof Sprite) {
        spies.push(vi.spyOn(o.material, 'dispose'));
        if (o.material.map) textures.add(o.material.map);
      }
      if (o instanceof Mesh && o.name.startsWith('billboard-pointer')) {
        spies.push(vi.spyOn(o.material as MeshBasicMaterial, 'dispose'));
        spies.push(vi.spyOn(o.geometry, 'dispose'));
      }
    });
    for (const texture of textures) spies.push(vi.spyOn(texture, 'dispose'));
    expect(textures.size).toBe(4);
    layer.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

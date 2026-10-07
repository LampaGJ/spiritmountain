import { PerspectiveCamera, Sprite, Vector3 } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
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
  polygonCentroid,
  signWidthPx,
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
  it.each(ActivitySchema.options)('draws the %s panel, glyph and label', (sport) => {
    const ctx = recordingContext();
    const { symbol, label } = signGlyph(sport);
    drawSign(ctx, { sport, symbol, label, glyph: true, width: 512, height: 128 });
    const panel = ctx.calls.find((c) => c.op === 'fill');
    expect(panel?.fillStyle).toBe(hex(SPORT_COLOR[sport]));
    expect(panel?.globalAlpha).toBeCloseTo(0.9, 9);
    const glyphCall = ctx.calls.find((c) => c.op === 'fillText' && c.text === symbol);
    expect(glyphCall?.font).toContain('"Material Symbols Outlined"');
    expect(glyphCall?.fillStyle).toBe(hex(labelColorFor(SPORT_COLOR[sport])));
    const labelCall = ctx.calls.find((c) => c.op === 'fillText' && c.text === label);
    expect(labelCall?.fillStyle).toBe(hex(labelColorFor(SPORT_COLOR[sport])));
    expect(labelCall?.font).not.toContain('Material Symbols');
  });

  it('omits the glyph when glyph is false', () => {
    const ctx = recordingContext();
    drawSign(ctx, {
      sport: 'hike',
      symbol: 'hiking',
      label: 'Hike',
      glyph: false,
      width: 512,
      height: 128,
    });
    expect(ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.text)).toEqual(['Hike']);
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
  lineArea('way/2', 'mtb-trail', 100, 0),
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
    resolution: { width: 1200, height: 800 },
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
  it('shows one sign per cluster on first build, the lift included', () => {
    const { layer } = build();
    // way/1 and way/2 are one mtb cluster; way/3 alpine; way/4 lift-ride.
    expect(visibleSprites(layer.group)).toHaveLength(3);
    expect(layer.stats().clusterCount).toBe(3);
    expect(layer.stats().perSport['lift-ride']).toBe(1);
  });

  it('draws the panel with no depth test above the ghost pass, and a depth-tested pole', () => {
    const { layer } = build();
    const sprite = visibleSprites(layer.group)[0] as Sprite;
    expect(sprite.material.depthTest).toBe(false);
    expect(sprite.material.depthWrite).toBe(false);
    expect(sprite.renderOrder).toBe(GHOST_RENDER_ORDER + 1);
    const poles: Line2[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Line2) poles.push(o);
    });
    expect(poles.length).toBeGreaterThan(0);
    expect(poles[0]?.material.depthTest).toBe(true);
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
    expect(visible).toHaveLength(1);
    expect(visible[0]?.userData['sport']).toBe('mountain-bike');
    layer.applyFilter(NO_ANNOTATIONS, new Set(), ALL_IDS);
    expect(visibleSprites(layer.group)).toHaveLength(3);
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
    const sign = sprites(layer.group).find((s) => s.userData['sport'] === 'alpine-ski') as Sprite;
    const ground = surface.sample(-200, 200).height;
    expect(sign.position.y).toBeCloseTo(ground + SIGN_OFFSET_M, 6);
    const raised: MeshSurface = {
      ...surface,
      sample: (e, n) => {
        const s = surface.sample(e, n);
        return { ...s, height: s.height + 40 };
      },
    };
    layer.redrape(raised);
    expect(sign.position.y).toBeCloseTo(ground + 40 + SIGN_OFFSET_M, 6);
    layer.redrape(surface);
    expect(sign.position.y).toBeCloseTo(ground + SIGN_OFFSET_M, 6);
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
    expect(layer.stats().clusterCount).toBe(3);
    expect(visibleSprites(layer.group).length).toBeLessThan(3);
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
      resolution: { width: 1200, height: 800 },
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
      if (o instanceof Line2) {
        spies.push(vi.spyOn(o.material, 'dispose'));
        spies.push(vi.spyOn(o.geometry, 'dispose'));
      }
    });
    for (const texture of textures) spies.push(vi.spyOn(texture, 'dispose'));
    expect(textures.size).toBe(3);
    layer.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

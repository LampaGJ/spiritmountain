/**
 * Sport billboards (#43): a flat, camera-facing sign in the sport colour floats above each cluster of same-sport areas,
 * showing the rail button's Material Symbols glyph and title-case label, on a tapered pointer down to the ground.
 *
 * The first half of this file is pure (no three object is created), so clustering, contrast, sizing and the canvas
 * drawing test in node with a recording fake context. The second half builds the three layer.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { fadeAlpha } from '../../scripts/ingest/context-tiles';
import type { Annotation } from '../schema/annotation';
import type { Area } from '../schema/area';
import { signGlyph } from '../ui/icons';
import { GHOST_RENDER_ORDER, type SceneMapper } from './areas';
import { effectiveScale } from './elevated';
import type { MeshSurface } from './heightfield';
import { SPORT_COLOR } from './palette';
import type { FrameCallback } from './scene';
import { sportForArea, type Activity } from './sport-routing';

/** Same-sport area centroids closer than this (single linkage, transitive) share one sign. */
export const SIGN_CLUSTER_RADIUS_M = 150;
/** The sign base floats this far above the active surface, in world metres before exaggeration. */
export const SIGN_OFFSET_M = 25;
/** Upper bound on the sign width in CSS pixels. */
export const SIGN_MAX_WIDTH_PX = 160;
/** On narrow viewports the sign takes at most this fraction of the viewport width. */
export const SIGN_WIDTH_FRACTION = 0.2;
/** Panel alpha; the terrain shows faintly through. */
export const SIGN_PANEL_ALPHA = 0.9;
/** Light and dark label colours; labelColorFor picks the higher-contrast one per sport. */
export const LABEL_LIGHT = 0xffffff;
export const LABEL_DARK = 0x111111;
/** Canvas size of one sign texture in device pixels (aspect 4:1). */
export const SIGN_CANVAS_WIDTH = 512;
export const SIGN_CANVAS_HEIGHT = 128;
/**
 * The pointer under a sign is a camera-facing triangle: this fraction of the panel width at the sign's bottom edge,
 * tapering to a point on the ground (Graham, 2026-10-08: "a tapered line from n width to 0 width at point").
 */
export const POINTER_WIDTH_FRACTION = 0.35;
const SYMBOL_FONT_FAMILY = '"Material Symbols Outlined"';
const LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export interface PlanePoint {
  readonly east: number;
  readonly north: number;
}

/** Midpoint by length of a polyline (local metres, z ignored). A zero-length line falls back to its first point. */
export function lineCentroid(coords: ReadonlyArray<ReadonlyArray<number>>): PlanePoint {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1] as ReadonlyArray<number>;
    const b = coords[i] as ReadonlyArray<number>;
    total += Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
  }
  const first = coords[0];
  if (first === undefined) throw new Error('lineCentroid: empty line');
  if (total === 0) return { east: first[0] ?? 0, north: first[1] ?? 0 };
  let remaining = total / 2;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1] as ReadonlyArray<number>;
    const b = coords[i] as ReadonlyArray<number>;
    const ax = a[0] ?? 0;
    const ay = a[1] ?? 0;
    const bx = b[0] ?? 0;
    const by = b[1] ?? 0;
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= remaining && seg > 0) {
      const t = remaining / seg;
      return { east: ax + t * (bx - ax), north: ay + t * (by - ay) };
    }
    remaining -= seg;
  }
  const last = coords[coords.length - 1] as ReadonlyArray<number>;
  return { east: last[0] ?? 0, north: last[1] ?? 0 };
}

/** Shoelace area centroid of one ring (closed or not; holes are the caller's to ignore). Degenerate: vertex mean. */
export function polygonCentroid(ring: ReadonlyArray<ReadonlyArray<number>>): PlanePoint {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1];
  const points = closed ? ring.slice(0, -1) : ring;
  if (points.length === 0) throw new Error('polygonCentroid: empty ring');
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as ReadonlyArray<number>;
    const b = points[(i + 1) % points.length] as ReadonlyArray<number>;
    const ax = a[0] ?? 0;
    const ay = a[1] ?? 0;
    const bx = b[0] ?? 0;
    const by = b[1] ?? 0;
    const cross = ax * by - bx * ay;
    twiceArea += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p[0] ?? 0;
      sy += p[1] ?? 0;
    }
    return { east: sx / points.length, north: sy / points.length };
  }
  return { east: cx / (3 * twiceArea), north: cy / (3 * twiceArea) };
}

/** Line: length midpoint. Polygon: outer-ring area centroid. */
export function areaCentroid(geometry: Area['geometry']): PlanePoint {
  if (geometry.type === 'LineString') return lineCentroid(geometry.coordinates);
  const outer = geometry.coordinates[0];
  if (outer === undefined) throw new Error('areaCentroid: polygon has no ring');
  return polygonCentroid(outer);
}

export interface ClusterInput {
  readonly id: string;
  /** The routed sport; null gets no sign. */
  readonly sport: Activity | null;
  readonly east: number;
  readonly north: number;
}

export interface SignCluster {
  readonly sport: Activity;
  /** Mean of the member centroids. */
  readonly east: number;
  readonly north: number;
  /** Sorted by code point. */
  readonly memberIds: readonly string[];
}

const codePointCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Single-linkage clusters per sport (union-find, transitive) of centroids within radiusM. Sorted by sport then smallest
 * member id, by code point. Null-routed inputs are dropped.
 */
export function clusterAreas(
  inputs: readonly ClusterInput[],
  radiusM = SIGN_CLUSTER_RADIUS_M,
): SignCluster[] {
  const routed = inputs
    .filter((i): i is ClusterInput & { sport: Activity } => i.sport !== null)
    .slice()
    .sort((a, b) => codePointCompare(a.sport, b.sport) || codePointCompare(a.id, b.id));
  const parent = routed.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    let node = i;
    while (parent[node] !== root) {
      const next = parent[node] as number;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  for (let i = 0; i < routed.length; i++) {
    const a = routed[i] as (typeof routed)[number];
    for (let j = i + 1; j < routed.length; j++) {
      const b = routed[j] as (typeof routed)[number];
      if (b.sport !== a.sport) break; // sorted by sport: no later entry shares it
      if (Math.hypot(a.east - b.east, a.north - b.north) <= radiusM) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const groups = new Map<number, Array<(typeof routed)[number]>>();
  routed.forEach((entry, i) => {
    const root = find(i);
    const members = groups.get(root);
    if (members) members.push(entry);
    else groups.set(root, [entry]);
  });
  const clusters: SignCluster[] = [...groups.values()].map((members) => {
    let east = 0;
    let north = 0;
    for (const m of members) {
      east += m.east;
      north += m.north;
    }
    const first = members[0] as (typeof members)[number];
    return {
      sport: first.sport,
      east: east / members.length,
      north: north / members.length,
      memberIds: members.map((m) => m.id).sort(codePointCompare),
    };
  });
  return clusters.sort(
    (a, b) =>
      codePointCompare(a.sport, b.sport) ||
      codePointCompare(a.memberIds[0] ?? '', b.memberIds[0] ?? ''),
  );
}

/** WCAG 2 relative luminance of a 0xRRGGBB colour. */
export function relativeLuminance(hex: number): number {
  const channel = (shift: number): number => {
    const c = ((hex >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG 2 contrast ratio between two 0xRRGGBB colours (1 to 21). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White or near-black, whichever has the higher contrast against the panel colour. */
export function labelColorFor(panelHex: number): number {
  return contrastRatio(LABEL_LIGHT, panelHex) >= contrastRatio(LABEL_DARK, panelHex)
    ? LABEL_LIGHT
    : LABEL_DARK;
}

/** Sign width in CSS pixels: 160, or a fifth of the viewport on narrow screens (78 at 390). */
export function signWidthPx(viewportWidthPx: number): number {
  return Math.round(Math.min(SIGN_MAX_WIDTH_PX, SIGN_WIDTH_FRACTION * viewportWidthPx));
}

/** A sign on screen in CSS pixels (top-left x, y), with its camera distance in world units. */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly distance: number;
}

/** Gap kept between two shown signs, in CSS pixels. */
export const SIGN_GAP_PX = 4;

/**
 * Screen-space declutter: nearest first, a sign is shown only when its rect (plus SIGN_GAP_PX) overlaps no sign
 * already shown. Returns one flag per input, in input order. Equal distances keep input order (the sorted clusters).
 */
export function declutter(rects: readonly ScreenRect[]): boolean[] {
  const order = rects
    .map((_, i) => i)
    .sort((a, b) => {
      const d = (rects[a] as ScreenRect).distance - (rects[b] as ScreenRect).distance;
      return d !== 0 ? d : a - b;
    });
  const shown = rects.map(() => false);
  const kept: ScreenRect[] = [];
  for (const i of order) {
    const r = rects[i] as ScreenRect;
    const hit = kept.some(
      (k) =>
        r.x < k.x + k.w + SIGN_GAP_PX &&
        k.x < r.x + r.w + SIGN_GAP_PX &&
        r.y < k.y + k.h + SIGN_GAP_PX &&
        k.y < r.y + r.h + SIGN_GAP_PX,
    );
    if (!hit) {
      kept.push(r);
      shown[i] = true;
    }
  }
  return shown;
}

/** The slice of CanvasRenderingContext2D the sign uses; tests pass a recording fake. */
export interface SignContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
}

export interface SignSpec {
  readonly sport: Activity;
  readonly symbol: string;
  readonly label: string;
  /** False until the Material Symbols font has loaded (or forever when it fails): panel and label only. */
  readonly glyph: boolean;
  readonly width: number;
  readonly height: number;
}

const cssHex = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

/** Draws one sign: rounded panel in the sport colour at 0.9 alpha, then glyph and label in the label colour. */
export function drawSign(ctx: SignContext2D, spec: SignSpec): void {
  const { width: w, height: h } = spec;
  ctx.clearRect(0, 0, w, h);
  const r = h * 0.22;
  ctx.globalAlpha = SIGN_PANEL_ALPHA;
  ctx.fillStyle = cssHex(SPORT_COLOR[spec.sport]);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.fillStyle = cssHex(labelColorFor(SPORT_COLOR[spec.sport]));
  ctx.textBaseline = 'middle';
  const pad = h * 0.14;
  const glyphSize = Math.round(h * 0.72);
  let textLeft = pad;
  if (spec.glyph) {
    ctx.font = `${glyphSize}px ${SYMBOL_FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(spec.symbol, pad, h / 2);
    textLeft = pad + glyphSize + pad * 0.6;
  }
  const available = w - textLeft - pad;
  let labelSize = Math.round(h * 0.42);
  ctx.font = `600 ${labelSize}px ${LABEL_FONT_FAMILY}`;
  const measured = ctx.measureText(spec.label).width;
  if (measured > available && measured > 0) {
    labelSize = Math.max(12, Math.floor((labelSize * available) / measured));
    ctx.font = `600 ${labelSize}px ${LABEL_FONT_FAMILY}`;
  }
  ctx.textAlign = spec.glyph ? 'left' : 'center';
  ctx.fillText(spec.label, spec.glyph ? textLeft : w / 2, h / 2);
}

/** The slice of FontFaceSet the loader uses. */
export interface SignFontSet {
  load(font: string, text?: string): Promise<readonly unknown[]>;
}

/**
 * Loads the Material Symbols ligature for every symbol. `document.fonts.ready` alone resolves at once when nothing is
 * pending, so each glyph is requested explicitly. Returns false (one warning) when fonts is undefined (jsdom), a load
 * rejects, or a load matches no face.
 */
export async function loadSignFont(
  fonts: SignFontSet | undefined,
  symbols: readonly string[],
  warn: (message: string) => void,
): Promise<boolean> {
  if (fonts === undefined) {
    warn('billboards: document.fonts is unavailable; signs show the label only');
    return false;
  }
  try {
    const faces = await Promise.all(
      symbols.map((symbol) => fonts.load(`24px ${SYMBOL_FONT_FAMILY}`, symbol)),
    );
    if (faces.some((matched) => matched.length === 0)) {
      warn('billboards: Material Symbols did not load; signs show the label only');
      return false;
    }
    return true;
  } catch (error) {
    warn(
      `billboards: Material Symbols failed to load (${error instanceof Error ? error.message : String(error)}); signs show the label only`,
    );
    return false;
  }
}

// ---- the three layer ----

/** The slice of SceneHandle the layer reads; the callback receives only deltaMs, so camera and renderer come from here. */
export interface BillboardFrameHost {
  readonly camera: PerspectiveCamera;
  readonly renderer: {
    readonly domElement: { readonly clientWidth: number; readonly clientHeight: number };
  };
  readonly exaggeration: number;
  onFrame(callback: FrameCallback): () => void;
}

export interface SignCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): SignContext2D | null;
}

export interface BillboardDeps {
  readonly host: BillboardFrameHost;
  /** The radial fade centre in local metres, passed by value. */
  readonly fadeCentre: PlanePoint;
  /** Defaults to document.createElement('canvas'). */
  readonly createCanvas?: () => SignCanvas;
  /** Defaults to document.fonts; pass undefined explicitly for none. */
  readonly fonts?: SignFontSet | undefined;
  /** Defaults to console.warn. */
  readonly warn?: (message: string) => void;
}

export interface BillboardStats {
  /** Clusters (= visible-eligible signs) after the last applyFilter. */
  readonly clusterCount: number;
  /** Clusters per sport after the last applyFilter. */
  readonly perSport: Readonly<Partial<Record<Activity, number>>>;
  /** Sprites allocated over the layer's life (pooled). */
  readonly pooledSigns: number;
  /** Signs drawn after fade and screen-space declutter on the last frame. */
  readonly shownCount: number;
}

export interface BillboardLayer {
  readonly group: Group;
  /** Re-routes (sportForArea), re-clusters the visible areas and shows one sign per cluster. */
  applyFilter(
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void;
  /** Re-heights every sign and pointer from another surface (composite while Surface is on, bare earth otherwise). */
  redrape(active: MeshSurface): void;
  setVisible(on: boolean): void;
  stats(): BillboardStats;
  dispose(): void;
}

interface Sign {
  readonly sprite: Sprite;
  readonly material: SpriteMaterial;
  readonly pointer: Mesh;
  readonly pointerGeometry: BufferGeometry;
  readonly pointerMaterial: MeshBasicMaterial;
  /** Ground point (triangle apex) and sign bottom centre (triangle base midpoint), scene coordinates. */
  readonly base: Vector3;
  readonly top: Vector3;
  active: boolean;
  east: number;
  north: number;
}

/**
 * @displayName Sport billboard layer
 * @strategicPurpose Lets a viewer see which sport lives where on the mountain at a glance, using the same glyph, label
 *   and colour as the rail button, without hovering or reading the lines.
 * @tacticalObjective Clusters visible routed areas per sport and draws one pooled, camera-facing, screen-sized sprite
 *   with a pointer per cluster inside the ElevatedGroup, compensating the group's y-scale each frame.
 */
export function buildBillboardLayer(
  areas: readonly Area[],
  surface: MeshSurface,
  toScene: SceneMapper,
  deps: BillboardDeps,
): BillboardLayer {
  const { host, fadeCentre } = deps;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const createCanvas =
    deps.createCanvas ?? ((): SignCanvas => document.createElement('canvas') as SignCanvas);
  const fonts: SignFontSet | undefined =
    'fonts' in deps
      ? deps.fonts
      : typeof document === 'undefined'
        ? undefined
        : (document.fonts as SignFontSet | undefined);

  const group = new Group();
  group.name = 'billboards';
  const centroids = new Map<string, PlanePoint>();
  for (const area of areas) centroids.set(area.id, areaCentroid(area.geometry));
  let activeSurface = surface;
  let glyphReady = false;
  let disposed = false;

  interface SportTexture {
    readonly canvas: SignCanvas;
    readonly texture: CanvasTexture;
  }
  const textures = new Map<Activity, SportTexture>();
  const paint = (sport: Activity, entry: SportTexture): void => {
    const ctx = entry.canvas.getContext('2d');
    if (!ctx) return;
    const { symbol, label } = signGlyph(sport);
    drawSign(ctx, {
      sport,
      symbol,
      label,
      glyph: glyphReady,
      width: SIGN_CANVAS_WIDTH,
      height: SIGN_CANVAS_HEIGHT,
    });
    entry.texture.needsUpdate = true;
  };
  const textureFor = (sport: Activity): CanvasTexture => {
    const cached = textures.get(sport);
    if (cached) return cached.texture;
    const canvas = createCanvas();
    canvas.width = SIGN_CANVAS_WIDTH;
    canvas.height = SIGN_CANVAS_HEIGHT;
    const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    const entry = { canvas, texture };
    textures.set(sport, entry);
    paint(sport, entry);
    return texture;
  };

  const pools = new Map<Activity, Sign[]>();
  let pooledSigns = 0;
  const makeSign = (sport: Activity): Sign => {
    const material = new SpriteMaterial({
      map: textureFor(sport),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new Sprite(material);
    // Anchor at the bottom centre, so the sign rests on its pointer.
    sprite.center.set(0.5, 0);
    sprite.renderOrder = GHOST_RENDER_ORDER + 1;
    sprite.raycast = () => {};
    sprite.name = `billboard:${sport}`;
    sprite.userData['sport'] = sport;
    const pointerGeometry = new BufferGeometry();
    pointerGeometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    const pointerMaterial = new MeshBasicMaterial({
      color: SPORT_COLOR[sport],
      transparent: true,
      side: DoubleSide,
    });
    const pointer = new Mesh(pointerGeometry, pointerMaterial);
    pointer.name = `billboard-pointer:${sport}`;
    pointer.raycast = () => {};
    pointer.frustumCulled = false;
    group.add(pointer, sprite);
    pooledSigns += 1;
    return {
      sprite,
      material,
      pointer,
      pointerGeometry,
      pointerMaterial,
      base: new Vector3(),
      top: new Vector3(),
      active: false,
      east: 0,
      north: 0,
    };
  };

  const place = (sign: Sign): void => {
    const ground = activeSurface.sample(sign.east, sign.north).height;
    const [bx, by, bz] = toScene(sign.east, sign.north, ground);
    const [tx, ty, tz] = toScene(sign.east, sign.north, ground + SIGN_OFFSET_M);
    sign.sprite.position.set(tx, ty, tz);
    sign.base.set(bx, by, bz);
    sign.top.set(tx, ty, tz);
  };

  let lastClusters: SignCluster[] = [];
  let shownCount = 0;
  const applyFilter = (
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void => {
    const inputs: ClusterInput[] = [];
    for (const area of areas) {
      if (!visibleIds.has(area.id)) continue;
      const centroid = centroids.get(area.id) as PlanePoint;
      inputs.push({
        id: area.id,
        sport: sportForArea(area, annotations.get(area.id), selected),
        east: centroid.east,
        north: centroid.north,
      });
    }
    lastClusters = clusterAreas(inputs);
    const used = new Map<Activity, number>();
    for (const cluster of lastClusters) {
      const index = used.get(cluster.sport) ?? 0;
      used.set(cluster.sport, index + 1);
      let pool = pools.get(cluster.sport);
      if (!pool) {
        pool = [];
        pools.set(cluster.sport, pool);
      }
      const sign = pool[index] ?? makeSign(cluster.sport);
      if (pool[index] === undefined) pool.push(sign);
      sign.active = true;
      sign.east = cluster.east;
      sign.north = cluster.north;
      sign.sprite.visible = true;
      sign.pointer.visible = true;
      place(sign);
    }
    for (const [sport, pool] of pools) {
      for (let i = used.get(sport) ?? 0; i < pool.length; i++) {
        const sign = pool[i] as Sign;
        sign.active = false;
        sign.sprite.visible = false;
        sign.pointer.visible = false;
      }
    }
  };

  const redrape = (active: MeshSurface): void => {
    activeSurface = active;
    for (const pool of pools.values()) {
      for (const sign of pool) if (sign.active) place(sign);
    }
  };

  const world = new Vector3();
  const right = new Vector3();
  const ndc = new Vector3();
  const view = new Vector3();
  const onFrame = (): void => {
    if (!group.visible) return;
    const { camera, renderer } = host;
    const viewportW = renderer.domElement.clientWidth;
    const viewportH = Math.max(renderer.domElement.clientHeight, 1);
    const tanHalf = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    const widthPx = signWidthPx(viewportW);
    const heightPx = (widthPx * SIGN_CANVAS_HEIGHT) / SIGN_CANVAS_WIDTH;
    const ys = effectiveScale(host.exaggeration);
    // Camera right, projected level: the pointer base always faces the camera like the sprite above it.
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0;
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    const candidates: Sign[] = [];
    const rects: ScreenRect[] = [];
    for (const pool of pools.values()) {
      for (const sign of pool) {
        if (!sign.active) continue;
        sign.sprite.getWorldPosition(world);
        const horizontal = Math.hypot(world.x - fadeCentre.east, world.z + fadeCentre.north);
        const alpha = fadeAlpha(horizontal);
        sign.sprite.visible = false;
        sign.pointer.visible = false;
        if (alpha <= 0) continue;
        sign.material.opacity = alpha;
        sign.pointerMaterial.opacity = alpha;
        // View-space depth sets the pixel size of a point at any screen position; Euclidean distance overstates it off-axis.
        const d = Math.max(
          -view.copy(world).applyMatrix4(camera.matrixWorldInverse).z,
          camera.near,
        );
        const w = widthPx * ((2 * d * tanHalf) / viewportH);
        sign.sprite.scale.set(w, (w * heightPx) / widthPx / ys, 1);
        // Pointer: base across the sign's bottom edge (camera right, kept level), apex on the ground.
        const hw = (POINTER_WIDTH_FRACTION * w) / 2;
        const pos = sign.pointerGeometry.getAttribute('position') as BufferAttribute;
        pos.setXYZ(0, sign.base.x, sign.base.y, sign.base.z);
        pos.setXYZ(1, sign.top.x - right.x * hw, sign.top.y, sign.top.z - right.z * hw);
        pos.setXYZ(2, sign.top.x + right.x * hw, sign.top.y, sign.top.z + right.z * hw);
        pos.needsUpdate = true;
        ndc.copy(world).project(camera);
        // Behind the camera or outside the clip range: never drawn, so it occupies no screen space.
        if (ndc.z < -1 || ndc.z > 1) continue;
        const cx = ((ndc.x + 1) / 2) * viewportW;
        const baseY = ((1 - ndc.y) / 2) * viewportH;
        candidates.push(sign);
        rects.push({
          x: cx - widthPx / 2,
          y: baseY - heightPx,
          w: widthPx,
          h: heightPx,
          distance: d,
        });
      }
    }
    const shown = declutter(rects);
    candidates.forEach((sign, i) => {
      const on = shown[i] === true;
      sign.sprite.visible = on;
      sign.pointer.visible = on;
    });
    shownCount = shown.filter(Boolean).length;
  };
  const unsubscribe = host.onFrame(onFrame);

  // First paint: every area visible, kind-default routing. The first filter apply re-routes.
  applyFilter(new Map(), new Set(), new Set(areas.map((a) => a.id)));
  onFrame();

  void loadSignFont(
    fonts,
    [...new Set(Object.keys(SPORT_COLOR).map((s) => signGlyph(s as Activity).symbol))],
    warn,
  ).then((ok) => {
    if (!ok || disposed) return;
    glyphReady = true;
    for (const [sport, entry] of textures) paint(sport, entry);
  });

  return {
    group,
    applyFilter,
    redrape,
    setVisible(on: boolean) {
      group.visible = on;
    },
    stats() {
      const perSport: Partial<Record<Activity, number>> = {};
      for (const cluster of lastClusters) {
        perSport[cluster.sport] = (perSport[cluster.sport] ?? 0) + 1;
      }
      return { clusterCount: lastClusters.length, perSport, pooledSigns, shownCount };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const pool of pools.values()) {
        for (const sign of pool) {
          sign.material.dispose();
          sign.pointerMaterial.dispose();
          sign.pointerGeometry.dispose();
        }
      }
      for (const { texture } of textures.values()) texture.dispose();
      pools.clear();
      textures.clear();
      group.removeFromParent();
      group.clear();
    },
  };
}

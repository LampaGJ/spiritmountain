/**
 * Track signs (#43, #49): a flat, camera-facing sign floats at the START and END of each track, listing every sport
 * that uses the place as a coloured glyph chip and the track name (or "N trails") below, on a 15 degree right-triangle
 * pointer down to the ground. The sign and its pointer move as one rigid group.
 *
 * The first half of this file is pure (no three object is created), so track planning, contrast, sizing and the canvas
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
import { ActivitySchema, type Annotation } from '../schema/annotation';
import type { Area } from '../schema/area';
import { iconFor, signGlyph } from '../ui/icons';
import { GHOST_RENDER_ORDER, type SceneMapper } from './areas';
import { effectiveScale } from './elevated';
import type { MeshSurface } from './heightfield';
import { SPORT_COLOR } from './palette';
import type { FrameCallback } from './scene';
import { KIND_DEFAULT_ACTIVITY, sportForArea, type Activity } from './sport-routing';
import { trackKey, trackName } from './track-key';

/** Same-sport area centroids closer than this (single linkage, transitive) share one sign. */
export const SIGN_CLUSTER_RADIUS_M = 150;
/** The sign base floats this far above the active surface, in world metres before exaggeration. */
export const SIGN_OFFSET_M = 25;
/** Upper bound on the sign width in CSS pixels. */
export const SIGN_MAX_WIDTH_PX = 160;
/** On narrow viewports the sign takes at most this fraction of the viewport width. */
export const SIGN_WIDTH_FRACTION = 0.2;
/** Panel colour: dark and neutral, so the sport-coloured chips carry the colour. */
export const SIGN_PANEL_COLOR = 0x1b1f24;
/** Panel alpha; the terrain shows faintly through. */
export const SIGN_PANEL_ALPHA = 0.9;
/** Light and dark label colours; labelColorFor picks the higher-contrast one per sport. */
export const LABEL_LIGHT = 0xffffff;
export const LABEL_DARK = 0x111111;
/** Canvas size of one sign texture in device pixels (aspect 4:1). */
export const SIGN_CANVAS_WIDTH = 512;
export const SIGN_CANVAS_HEIGHT = 128;
/**
 * The pointer's leg 2 leaves the ground point at this angle from leg 1, which goes straight up (Graham, 2026-10-08:
 * "make one side at 90 degrees from level ... going straight UP (leg 1) ... leg 2 ... about a 15 degree angle").
 */
export const POINTER_ANGLE_DEG = 15;
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

// ---- tracks, endpoints and signs (#49) ----

/** Two endpoints of different segments closer than this are one junction, so neither is a free end of the track. */
export const FREE_ENDPOINT_TOLERANCE_M = 5;
/** An END sign this close to its START is dropped: the track is too short to need two signs. */
export const END_MIN_DISTANCE_M = 150;
/** Signs closer than this (single linkage) merge into one sign carrying the union of their activities. */
export const SIGN_MERGE_RADIUS_M = 60;

/** The slice of an Area the track planner reads. */
export type TrackArea = Pick<Area, 'id' | 'kind' | 'name' | 'osmTags' | 'geometry'>;

/** Bare-earth or composite surface height in metres at a local east/north position. */
export type HeightAt = (east: number, north: number) => number;

export type SignRole = 'start' | 'end';

/** Where a track begins and ends. `end` is null for a loop, a one-point track, or an END dropped as too close. */
export interface TrackEnds {
  readonly start: PlanePoint;
  readonly end: PlanePoint | null;
}

interface LineSegment {
  readonly id: string;
  readonly coords: ReadonlyArray<ReadonlyArray<number>>;
}

const planeDistance = (a: PlanePoint, b: PlanePoint): number =>
  Math.hypot(a.east - b.east, a.north - b.north);

const pointAt = (coords: ReadonlyArray<ReadonlyArray<number>>, index: number): PlanePoint => {
  const p = coords[index];
  if (p === undefined) throw new Error('trackEnds: empty line');
  return { east: p[0] ?? 0, north: p[1] ?? 0 };
};

/**
 * START and END of one track. An endpoint is free when no other segment of the track has an endpoint within
 * FREE_ENDPOINT_TOLERANCE_M; a segment whose own two ends meet (a closed way) contributes none. START is the free
 * endpoint with the highest `heightAt`, END the lowest (ties broken by east, then north). A track with no free
 * endpoint (a loop) gets one START at the first vertex of its smallest-id segment. An END within END_MIN_DISTANCE_M of
 * the START is dropped. A track with no line (polygons only) gets one START at the centroid of its smallest-id polygon.
 */
export function trackEnds(areas: readonly TrackArea[], heightAt: HeightAt): TrackEnds {
  const sorted = areas.slice().sort((a, b) => codePointCompare(a.id, b.id));
  const lines: LineSegment[] = [];
  for (const area of sorted) {
    if (area.geometry.type === 'LineString') {
      lines.push({ id: area.id, coords: area.geometry.coordinates });
    }
  }
  if (lines.length === 0) {
    const first = sorted[0];
    if (first === undefined) throw new Error('trackEnds: empty track');
    return { start: areaCentroid(first.geometry), end: null };
  }
  const ends: Array<{ segment: number; point: PlanePoint }> = [];
  lines.forEach((line, segment) => {
    const a = pointAt(line.coords, 0);
    const b = pointAt(line.coords, line.coords.length - 1);
    if (planeDistance(a, b) <= FREE_ENDPOINT_TOLERANCE_M) return;
    ends.push({ segment, point: a }, { segment, point: b });
  });
  const free = ends.filter(
    (e) =>
      !ends.some(
        (o) =>
          o.segment !== e.segment && planeDistance(o.point, e.point) <= FREE_ENDPOINT_TOLERANCE_M,
      ),
  );
  if (free.length === 0) {
    const first = lines[0] as LineSegment;
    return { start: pointAt(first.coords, 0), end: null };
  }
  const ranked = free
    .map((e) => ({ point: e.point, height: heightAt(e.point.east, e.point.north) }))
    .sort(
      (a, b) => b.height - a.height || a.point.east - b.point.east || a.point.north - b.point.north,
    );
  const start = (ranked[0] as (typeof ranked)[number]).point;
  const lowest = ranked[ranked.length - 1] as (typeof ranked)[number];
  const end = lowest.point;
  if (ranked.length < 2 || planeDistance(start, end) <= END_MIN_DISTANCE_M) {
    return { start, end: null };
  }
  return { start, end };
}

/** One planned sign: a place, a role, the sports that use it and its label. */
export interface SignPlan {
  readonly east: number;
  readonly north: number;
  readonly role: SignRole;
  /** In ActivitySchema.options order. */
  readonly activities: readonly Activity[];
  readonly label: string;
  /** Distinct tracks merged into this sign. */
  readonly trackCount: number;
}

interface Anchor {
  readonly east: number;
  readonly north: number;
  readonly role: SignRole;
  readonly key: string;
  readonly label: string;
  readonly activities: readonly Activity[];
}

/**
 * Activities of one track: the union over its segments of annotation activities that are in `selected` (every
 * annotated activity when `selected` is empty). A segment with none of those (a lift under a filter, an unannotated
 * area) contributes what sportForArea picks, so a visible track is never left without a chip.
 */
function trackActivities(
  members: readonly TrackArea[],
  annotations: ReadonlyMap<string, Annotation>,
  selected: ReadonlySet<Activity>,
): Activity[] {
  const found = new Set<Activity>();
  for (const area of members) {
    const carried = (annotations.get(area.id)?.activities ?? []).map((e) => e.activity);
    const hits = carried.filter((a) => selected.size === 0 || selected.has(a));
    if (hits.length === 0) found.add(sportForArea(area, annotations.get(area.id), selected));
    else for (const a of hits) found.add(a);
  }
  return ActivitySchema.options.filter((a) => found.has(a));
}

/**
 * The signs for the visible areas. Areas group into tracks by trackKey; each track yields a START anchor and maybe an
 * END anchor (trackEnds); anchors within SIGN_MERGE_RADIUS_M merge (single linkage) into one sign at their mean, with
 * the union of their activities. The label is the track name for one track, else `N trails`. A merged sign is a
 * START unless every member is an END. Output order is by east, then north, so it is stable across runs.
 */
export function planSigns(
  areas: readonly TrackArea[],
  annotations: ReadonlyMap<string, Annotation>,
  selected: ReadonlySet<Activity>,
  visibleIds: ReadonlySet<string>,
  heightAt: HeightAt,
): SignPlan[] {
  const tracks = new Map<string, TrackArea[]>();
  for (const area of areas) {
    if (!visibleIds.has(area.id)) continue;
    const key = trackKey(area);
    const members = tracks.get(key);
    if (members) members.push(area);
    else tracks.set(key, [area]);
  }
  const anchors: Anchor[] = [];
  for (const key of [...tracks.keys()].sort(codePointCompare)) {
    const members = tracks.get(key) as TrackArea[];
    const activities = trackActivities(members, annotations, selected);
    const first = members.slice().sort((a, b) => codePointCompare(a.id, b.id))[0] as TrackArea;
    const label =
      trackName(first) ??
      signGlyph((activities[0] ?? KIND_DEFAULT_ACTIVITY[first.kind]) as Activity).label;
    const ends = trackEnds(members, heightAt);
    anchors.push({ ...ends.start, role: 'start', key, label, activities });
    if (ends.end) anchors.push({ ...ends.end, role: 'end', key, label, activities });
  }
  anchors.sort(
    (a, b) =>
      a.east - b.east ||
      a.north - b.north ||
      codePointCompare(a.key, b.key) ||
      codePointCompare(a.role, b.role),
  );
  const parent = anchors.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const a = anchors[i] as Anchor;
      const b = anchors[j] as Anchor;
      if (planeDistance(a, b) <= SIGN_MERGE_RADIUS_M) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const groups = new Map<number, Anchor[]>();
  anchors.forEach((anchor, i) => {
    const root = find(i);
    const members = groups.get(root);
    if (members) members.push(anchor);
    else groups.set(root, [anchor]);
  });
  const plans: SignPlan[] = [...groups.values()].map((members) => {
    const keys = [...new Set(members.map((m) => m.key))];
    const activities = new Set(members.flatMap((m) => m.activities));
    const first = members[0] as Anchor;
    return {
      east: members.reduce((s, m) => s + m.east, 0) / members.length,
      north: members.reduce((s, m) => s + m.north, 0) / members.length,
      role: members.every((m) => m.role === 'end') ? 'end' : 'start',
      activities: ActivitySchema.options.filter((a) => activities.has(a)),
      label: keys.length === 1 ? first.label : `${keys.length} trails`,
      trackCount: keys.length,
    };
  });
  return plans.sort((a, b) => a.east - b.east || a.north - b.north);
}

/**
 * Local vertices of the pointer, a right triangle in the sign group's xy plane: apex at the origin (the ground point),
 * leg 1 straight up by `heightM`, leg 2 from the apex to the top edge's far end. In the ElevatedGroup the y axis is
 * scaled by `yScale` and x is not, so the x of the far end is `heightM * yScale * tan(angle)`: leg 2 then leaves leg 1
 * at `angleDeg` in the world whatever the exaggeration. Returns [x0, y0, z0, x1, y1, z1, x2, y2, z2].
 */
export function pointerVertices(
  heightM: number,
  angleDeg: number,
  yScale: number,
): [number, number, number, number, number, number, number, number, number] {
  const dx = heightM * yScale * Math.tan((angleDeg * Math.PI) / 180);
  return [0, 0, 0, 0, heightM, 0, dx, heightM, 0];
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
  arc(x: number, y: number, r: number, start: number, end: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
}

export interface SignSpec {
  /** Drawn as one chip each, in ActivitySchema.options order whatever the input order. */
  readonly activities: readonly Activity[];
  readonly label: string;
  readonly role: SignRole;
  /** False until the Material Symbols font has loaded (or forever when it fails): chips and label only. */
  readonly glyph: boolean;
  readonly width: number;
  readonly height: number;
}

const cssHex = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

const roleIconId = (role: SignRole): string => (role === 'start' ? 'track-start' : 'track-end');

/** Cache key of a sign texture: the same activities, label and role draw the same pixels. */
export const signTextureKey = (spec: Pick<SignSpec, 'activities' | 'label' | 'role'>): string =>
  `${spec.activities.join(',')}|${spec.label}|${spec.role}`;

/**
 * Draws one sign: a dark neutral rounded panel at SIGN_PANEL_ALPHA. Top row: one circular chip per activity filled
 * with SPORT_COLOR, holding the sport glyph. Bottom row: the start or end glyph and the label, in white.
 */
export function drawSign(ctx: SignContext2D, spec: SignSpec): void {
  const { width: w, height: h } = spec;
  ctx.clearRect(0, 0, w, h);
  const r = h * 0.22;
  ctx.globalAlpha = SIGN_PANEL_ALPHA;
  ctx.fillStyle = cssHex(SIGN_PANEL_COLOR);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 1;
  const pad = h * 0.12;
  const activities = ActivitySchema.options.filter((a) => spec.activities.includes(a));
  const topY = h * 0.28;
  const gap = h * 0.06;
  const chipR = Math.min(
    h * 0.2,
    (w - 2 * pad - gap * Math.max(activities.length - 1, 0)) / (2 * Math.max(activities.length, 1)),
  );
  activities.forEach((activity, i) => {
    const cx = pad + chipR + i * (2 * chipR + gap);
    ctx.fillStyle = cssHex(SPORT_COLOR[activity]);
    ctx.beginPath();
    ctx.arc(cx, topY, chipR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    if (spec.glyph) {
      ctx.fillStyle = cssHex(labelColorFor(SPORT_COLOR[activity]));
      ctx.font = `${Math.round(chipR * 1.5)}px ${SYMBOL_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(signGlyph(activity).symbol, cx, topY);
    }
  });

  const bottomY = h * 0.76;
  ctx.fillStyle = cssHex(LABEL_LIGHT);
  ctx.textBaseline = 'middle';
  const glyphSize = Math.round(h * 0.34);
  let textLeft = pad;
  if (spec.glyph) {
    ctx.font = `${glyphSize}px ${SYMBOL_FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(iconFor(roleIconId(spec.role)).symbol, pad, bottomY);
    textLeft = pad + glyphSize + pad * 0.6;
  }
  const available = w - textLeft - pad;
  let labelSize = Math.round(h * 0.32);
  ctx.font = `600 ${labelSize}px ${LABEL_FONT_FAMILY}`;
  const measured = ctx.measureText(spec.label).width;
  if (measured > available && measured > 0) {
    labelSize = Math.max(12, Math.floor((labelSize * available) / measured));
    ctx.font = `600 ${labelSize}px ${LABEL_FONT_FAMILY}`;
  }
  ctx.textAlign = spec.glyph ? 'left' : 'center';
  ctx.fillText(spec.label, spec.glyph ? textLeft : w / 2, bottomY);
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
  /** Signs (one per merged track start or end) after the last applyFilter or redrape. */
  readonly clusterCount: number;
  /** Signs carrying each activity chip after the last applyFilter or redrape. */
  readonly perSport: Readonly<Partial<Record<Activity, number>>>;
  /** Signs allocated over the layer's life (pooled). */
  readonly pooledSigns: number;
  /** Signs drawn after fade and screen-space declutter on the last frame. */
  readonly shownCount: number;
}

export interface BillboardLayer {
  readonly group: Group;
  /** Groups the visible areas into tracks and shows one sign per merged track start or end. */
  applyFilter(
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void;
  /** Re-heights every sign and pointer and re-picks each track's START and END from another surface. */
  redrape(active: MeshSurface): void;
  setVisible(on: boolean): void;
  stats(): BillboardStats;
  dispose(): void;
}

interface Sign {
  /** One rigid shape at the ground point: the pointer and the sprite are its only children. */
  readonly group: Group;
  readonly sprite: Sprite;
  readonly material: SpriteMaterial;
  readonly pointer: Mesh;
  readonly pointerMaterial: MeshBasicMaterial;
  active: boolean;
}

/**
 * @displayName Track sign layer
 * @strategicPurpose Lets a viewer see where each track starts and ends, and every sport that uses the place, without
 *   hovering or reading the lines, with few enough signs that the mountain stays visible.
 * @tacticalObjective Groups visible areas into tracks, plans one merged sign per track START or END, and draws each as a
 *   pooled rigid group (a 15 degree right-triangle pointer plus a camera-facing, screen-sized sprite) inside the
 *   ElevatedGroup, compensating the group's y-scale each frame.
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
  let activeSurface = surface;
  let glyphReady = false;
  let disposed = false;

  interface SignTexture {
    readonly canvas: SignCanvas;
    readonly texture: CanvasTexture;
    readonly spec: Pick<SignSpec, 'activities' | 'label' | 'role'>;
  }
  const textures = new Map<string, SignTexture>();
  const paint = (entry: SignTexture): void => {
    const ctx = entry.canvas.getContext('2d');
    if (!ctx) return;
    drawSign(ctx, {
      ...entry.spec,
      glyph: glyphReady,
      width: SIGN_CANVAS_WIDTH,
      height: SIGN_CANVAS_HEIGHT,
    });
    entry.texture.needsUpdate = true;
  };
  const textureFor = (spec: Pick<SignSpec, 'activities' | 'label' | 'role'>): CanvasTexture => {
    const key = signTextureKey(spec);
    const cached = textures.get(key);
    if (cached) return cached.texture;
    const canvas = createCanvas();
    canvas.width = SIGN_CANVAS_WIDTH;
    canvas.height = SIGN_CANVAS_HEIGHT;
    const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    const entry: SignTexture = { canvas, texture, spec };
    textures.set(key, entry);
    paint(entry);
    return texture;
  };

  // One fixed local shape shared by every pointer; only the far end's x changes, and only with the exaggeration.
  const pointerGeometry = new BufferGeometry();
  pointerGeometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  let pointerScale = Number.NaN;
  const shapePointer = (ys: number): void => {
    if (ys === pointerScale) return;
    pointerScale = ys;
    const pos = pointerGeometry.getAttribute('position') as BufferAttribute;
    pos.array.set(pointerVertices(SIGN_OFFSET_M, POINTER_ANGLE_DEG, ys));
    pos.needsUpdate = true;
  };
  shapePointer(effectiveScale(host.exaggeration));

  const pool: Sign[] = [];
  const makeSign = (plan: SignPlan): Sign => {
    const material = new SpriteMaterial({
      map: textureFor(plan),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new Sprite(material);
    // Anchor at the bottom-left corner: it sits on the top of leg 1 and the panel extends right and up from there.
    sprite.center.set(0, 0);
    sprite.position.set(0, SIGN_OFFSET_M, 0);
    sprite.renderOrder = GHOST_RENDER_ORDER + 1;
    sprite.raycast = () => {};
    const pointerMaterial = new MeshBasicMaterial({
      color: SPORT_COLOR[plan.activities[0] as Activity],
      transparent: true,
      side: DoubleSide,
    });
    const pointer = new Mesh(pointerGeometry, pointerMaterial);
    pointer.name = 'billboard-pointer';
    pointer.raycast = () => {};
    pointer.frustumCulled = false;
    const rigid = new Group();
    rigid.name = 'billboard-sign';
    rigid.add(pointer, sprite);
    group.add(rigid);
    return { group: rigid, sprite, material, pointer, pointerMaterial, active: false };
  };

  let lastArgs: {
    annotations: ReadonlyMap<string, Annotation>;
    selected: ReadonlySet<Activity>;
    visibleIds: ReadonlySet<string>;
  } = { annotations: new Map(), selected: new Set(), visibleIds: new Set() };
  let lastPlans: SignPlan[] = [];
  let shownCount = 0;
  const heightAt: HeightAt = (east, north) => activeSurface.sample(east, north).height;

  const rebuild = (): void => {
    const { annotations, selected, visibleIds } = lastArgs;
    lastPlans = planSigns(areas, annotations, selected, visibleIds, heightAt);
    lastPlans.forEach((plan, i) => {
      const sign = pool[i] ?? makeSign(plan);
      if (pool[i] === undefined) pool.push(sign);
      sign.active = true;
      sign.material.map = textureFor(plan);
      sign.pointerMaterial.color.setHex(SPORT_COLOR[plan.activities[0] as Activity]);
      sign.sprite.name = `billboard:${signTextureKey(plan)}`;
      sign.sprite.userData['activities'] = plan.activities;
      sign.sprite.userData['role'] = plan.role;
      sign.sprite.userData['label'] = plan.label;
      sign.sprite.visible = true;
      sign.pointer.visible = true;
      const ground = heightAt(plan.east, plan.north);
      const [x, y, z] = toScene(plan.east, plan.north, ground);
      sign.group.position.set(x, y, z);
    });
    for (let i = lastPlans.length; i < pool.length; i++) {
      const sign = pool[i] as Sign;
      sign.active = false;
      sign.sprite.visible = false;
      sign.pointer.visible = false;
    }
  };

  const applyFilter = (
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void => {
    lastArgs = { annotations, selected, visibleIds };
    rebuild();
  };

  const redrape = (active: MeshSurface): void => {
    activeSurface = active;
    rebuild();
  };

  const world = new Vector3();
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
    shapePointer(ys);
    const candidates: Sign[] = [];
    const rects: ScreenRect[] = [];
    for (const sign of pool) {
      if (!sign.active) continue;
      // The elevated group only scales and shifts y, so its x and z are the camera's x and z: yaw the triangle to face it.
      sign.group.rotation.y = Math.atan2(
        camera.position.x - sign.group.position.x,
        camera.position.z - sign.group.position.z,
      );
      sign.sprite.getWorldPosition(world);
      const horizontal = Math.hypot(world.x - fadeCentre.east, world.z + fadeCentre.north);
      const alpha = fadeAlpha(horizontal);
      sign.sprite.visible = false;
      sign.pointer.visible = false;
      if (alpha <= 0) continue;
      sign.material.opacity = alpha;
      sign.pointerMaterial.opacity = alpha;
      // View-space depth sets the pixel size of a point at any screen position; Euclidean distance overstates it off-axis.
      const d = Math.max(-view.copy(world).applyMatrix4(camera.matrixWorldInverse).z, camera.near);
      const w = widthPx * ((2 * d * tanHalf) / viewportH);
      sign.sprite.scale.set(w, (w * heightPx) / widthPx / ys, 1);
      ndc.copy(world).project(camera);
      // Behind the camera or outside the clip range: never drawn, so it occupies no screen space.
      if (ndc.z < -1 || ndc.z > 1) continue;
      const cx = ((ndc.x + 1) / 2) * viewportW;
      const baseY = ((1 - ndc.y) / 2) * viewportH;
      candidates.push(sign);
      // The sprite's bottom-left corner is the projected point, so the rect extends right and up from it.
      rects.push({ x: cx, y: baseY - heightPx, w: widthPx, h: heightPx, distance: d });
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
    [
      ...new Set([
        ...ActivitySchema.options.map((s) => signGlyph(s).symbol),
        iconFor('track-start').symbol,
        iconFor('track-end').symbol,
      ]),
    ],
    warn,
  ).then((ok) => {
    if (!ok || disposed) return;
    glyphReady = true;
    for (const entry of textures.values()) paint(entry);
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
      for (const plan of lastPlans) {
        for (const a of plan.activities) perSport[a] = (perSport[a] ?? 0) + 1;
      }
      return { clusterCount: lastPlans.length, perSport, pooledSigns: pool.length, shownCount };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const sign of pool) {
        sign.material.dispose();
        sign.pointerMaterial.dispose();
      }
      pointerGeometry.dispose();
      for (const { texture } of textures.values()) texture.dispose();
      pool.length = 0;
      textures.clear();
      group.removeFromParent();
      group.clear();
    },
  };
}

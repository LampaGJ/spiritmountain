/**
 * Track signs (#43, #49, #55, #60). Two families float above the mountain as flat, camera-facing sprites inside the
 * ElevatedGroup. Concentration signs hover over the natural concentrations of visible trails and list every sport
 * there as a coloured glyph chip with a track name or "N trails". Trail signs sit at the length midpoint of each named
 * track, one per track: the track name in bold on top, one sport chip per activity below, the panel and its tapered tail
 * drawn as one shape (#63) whose apex is the trail point.
 *
 * The first half of this file is pure (no three object is created), so track planning, contrast, sizing and the canvas
 * drawing test in node with a recording fake context. The second half builds the three layer.
 */
import {
  CanvasTexture,
  Group,
  LinearFilter,
  type PerspectiveCamera,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { fadeAlpha } from '../../scripts/ingest/context-tiles';
import { ActivitySchema, type Annotation } from '../schema/annotation';
import type { Area } from '../schema/area';
import type { Place } from '../schema/places';
import { signGlyph } from '../ui/icons';
import { trailTopHeight, type SceneMapper } from './areas';
import { effectiveScale } from './elevated';
import type { MeshSurface } from './heightfield';
import { SPORT_COLOR } from './palette';
import type { FrameCallback } from './scene';
import { KIND_DEFAULT_ACTIVITY, sportForArea, type Activity } from './sport-routing';
import { trackKey, trackName } from './track-key';

/** Signs draw after every default-order object; the panel has no depth test so it stays readable. */
export const SIGN_RENDER_ORDER = 2;
/**
 * A trail sign's tail: leg 1 is vertical, leg 2 leaves the apex at this angle from leg 1 (Graham, 2026-10-08: "make one
 * side at 90 degrees from level ... going straight UP (leg 1) ... leg 2 ... about a 15 degree angle").
 */
export const POINTER_ANGLE_DEG = 15;
/** Height of a trail sign's tail in canvas pixels at the 512 x 128 panel scale (about 60 screen px at 160 px wide). */
export const TAIL_PX = 120;
/**
 * Where leg 1 leaves the panel's bottom edge, as a fraction of the panel width: well past the corner radius (#63, Graham:
 * "meet up closer to middle of the sign itself (at least beyond the round rect corner)"). Also the sprite's x centre, so
 * the apex sits on the trail point.
 */
export const TAIL_X_FRACTION = 0.3;
/** A trail sign's chip radius as a fraction of the panel height: 1.4 x the earlier 0.19 (#63, Graham: "larger encircled icons"). */
export const TRAIL_CHIP_R_FRACTION = 0.19 * 1.4;
/** Same-sport area centroids closer than this (single linkage, transitive) share one sign. */
export const SIGN_CLUSTER_RADIUS_M = 150;
/** A concentration sign's base floats this far above the active surface, in world metres before exaggeration. */
export const SIGN_OFFSET_M = 25;
/** Upper bound on the sign width in CSS pixels. */
export const SIGN_MAX_WIDTH_PX = 160;
/** On narrow viewports the sign takes at most this fraction of the viewport width. */
export const SIGN_WIDTH_FRACTION = 0.2;
/** Concentration-sign panel colour: dark and neutral, so the sport-coloured chips carry the colour. */
export const SIGN_PANEL_COLOR = 0x1b1f24;
/** Panel alpha; the terrain shows faintly through. */
export const SIGN_PANEL_ALPHA = 0.9;
/** Light and dark label colours; labelColorFor picks the higher-contrast one per sport. */
export const LABEL_LIGHT = 0xffffff;
export const LABEL_DARK = 0x111111;
/** Canvas size of one sign texture in device pixels (aspect 4:1). */
export const SIGN_CANVAS_WIDTH = 512;
export const SIGN_CANVAS_HEIGHT = 128;
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

// ---- concentrations and signs (#55, replacing the #49 start/end anchors) ----

/** Two tracks join one concentration when any vertex of one lies within this distance of any vertex of the other. */
export const CONCENTRATION_RADIUS_M = 250;
/** A concentration with more tracks than this ... (8, not 12: with places claiming their own tracks, no leftover sign may claim the whole mountain, #61) */
export const SPLIT_TRACKS = 8;
/** ... and a plan extent (bounding-box diagonal) over this many metres splits in two with k-means. */
export const SPLIT_EXTENT_M = 1000;
/** A track belongs to the nearest place sign whose position lies within this many metres of the track's length-weighted centroid (#61). */
export const CATCHMENT_M = 900;
/** Place kinds that get their own sign. Lift tops and the campground only name a spot; they never gather tracks. */
export const PLACE_SIGN_KINDS: ReadonlySet<Place['kind']> = new Set<Place['kind']>([
  'chalet',
  'nordic-centre',
  'park-zone',
  'adventure-park',
  'peak',
  'overlook',
]);
/** Two endpoints of different segments closer than this are one junction, not a free end of the track. */
export const FREE_ENDPOINT_TOLERANCE_M = 5;
/** Fixed Lloyd iterations of the k = 2 split. */
export const SPLIT_ITERATIONS = 10;

/** The slice of an Area the track planner reads. */
export type TrackArea = Pick<Area, 'id' | 'kind' | 'name' | 'osmTags' | 'geometry'>;

/** A vertex of a track in local metres, with its share of the track's length as weight. */
export interface WeightedPoint {
  readonly east: number;
  readonly north: number;
  readonly weight: number;
}

const planeDistance = (a: PlanePoint, b: PlanePoint): number =>
  Math.hypot(a.east - b.east, a.north - b.north);

/**
 * Every vertex of an area as a weighted point. Each vertex carries half the length of the edges beside it, so a
 * track's weights sum to its length (a polygon uses its outer ring): a long trail counts for its length, not for how
 * many vertices OSM happened to give it. A zero-length geometry gets weight 1 per vertex so it still counts.
 */
export function areaVertices(geometry: Area['geometry']): WeightedPoint[] {
  const ring =
    geometry.type === 'LineString' ? geometry.coordinates : (geometry.coordinates[0] ?? []);
  if (ring.length === 0) throw new Error('areaVertices: empty geometry');
  const points = ring.map((c) => ({ east: c[0] ?? 0, north: c[1] ?? 0 }));
  const weights = points.map(() => 0);
  for (let i = 1; i < points.length; i++) {
    const length = planeDistance(points[i - 1] as PlanePoint, points[i] as PlanePoint);
    weights[i - 1] = (weights[i - 1] as number) + length / 2;
    weights[i] = (weights[i] as number) + length / 2;
  }
  const total = weights.reduce((s, w) => s + w, 0);
  return points.map((p, i) => ({ ...p, weight: total > 0 ? (weights[i] as number) : 1 }));
}

/** Weighted mean of weighted points. */
export function weightedCentroid(points: readonly WeightedPoint[]): PlanePoint {
  let east = 0;
  let north = 0;
  let weight = 0;
  for (const p of points) {
    east += p.east * p.weight;
    north += p.north * p.weight;
    weight += p.weight;
  }
  if (weight === 0) throw new Error('weightedCentroid: no weight');
  return { east: east / weight, north: north / weight };
}

/** One visible track: its key and every vertex of its visible segments. */
export interface TrackPoints {
  readonly key: string;
  readonly points: readonly WeightedPoint[];
}

/**
 * Single-linkage groups of tracks: two join when any vertex of one is within `radiusM` of any vertex of the other
 * (transitive). Returns indices into `tracks`, each group ascending, groups ordered by smallest member index.
 */
export function concentrateTracks(
  tracks: readonly TrackPoints[],
  radiusM = CONCENTRATION_RADIUS_M,
): number[][] {
  const parent = tracks.map((_, i) => i);
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
  // Grid of radius-sized cells: a vertex only needs its own and the eight neighbouring cells.
  const cells = new Map<string, Array<{ track: number; east: number; north: number }>>();
  const cellOf = (v: number): number => Math.floor(v / radiusM);
  tracks.forEach((track, t) => {
    for (const p of track.points) {
      const id = `${cellOf(p.east)},${cellOf(p.north)}`;
      const list = cells.get(id);
      const entry = { track: t, east: p.east, north: p.north };
      if (list) list.push(entry);
      else cells.set(id, [entry]);
    }
  });
  tracks.forEach((track, t) => {
    for (const p of track.points) {
      const cx = cellOf(p.east);
      const cy = cellOf(p.north);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const q of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (q.track === t || Math.hypot(p.east - q.east, p.north - q.north) > radiusM) continue;
            const ra = find(t);
            const rb = find(q.track);
            if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
          }
        }
      }
    }
  });
  const groups = new Map<number, number[]>();
  tracks.forEach((_, i) => {
    const root = find(i);
    const members = groups.get(root);
    if (members) members.push(i);
    else groups.set(root, [i]);
  });
  return [...groups.values()];
}

/** Bounding-box diagonal of a set of points, in metres. */
export function planExtent(points: readonly PlanePoint[]): number {
  if (points.length === 0) return 0;
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const p of points) {
    minE = Math.min(minE, p.east);
    maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north);
    maxN = Math.max(maxN, p.north);
  }
  return Math.hypot(maxE - minE, maxN - minN);
}

/** A weighted vertex tagged with the index of the track it belongs to. */
export interface OwnedPoint extends WeightedPoint {
  readonly track: number;
}

/**
 * Deterministic k = 2 split of weighted vertices. Seeds: `seed` (the caller passes the centroid of the track with the
 * smallest key) and the vertex farthest from it (ties by east, then north). Then SPLIT_ITERATIONS Lloyd steps on
 * weighted means, a vertex going to the nearer centre (ties to the first). Returns the two vertex sets.
 */
export function splitInTwo(
  points: readonly OwnedPoint[],
  seed: PlanePoint,
): [OwnedPoint[], OwnedPoint[]] {
  let far = points[0] as OwnedPoint;
  for (const p of points) {
    const d = planeDistance(p, seed) - planeDistance(far, seed);
    if (d > 0 || (d === 0 && (p.east < far.east || (p.east === far.east && p.north < far.north)))) {
      far = p;
    }
  }
  let centres: [PlanePoint, PlanePoint] = [seed, { east: far.east, north: far.north }];
  let sides: [OwnedPoint[], OwnedPoint[]] = [[], []];
  for (let iteration = 0; iteration < SPLIT_ITERATIONS; iteration++) {
    sides = [[], []];
    for (const p of points) {
      (planeDistance(p, centres[0]) <= planeDistance(p, centres[1]) ? sides[0] : sides[1]).push(p);
    }
    if (sides[0].length === 0 || sides[1].length === 0) break;
    centres = [weightedCentroid(sides[0]), weightedCentroid(sides[1])];
  }
  return sides;
}

export type SignFamily = 'concentration' | 'trail';

/** One planned sign: a place over a concentration of tracks (or on a named track), the sports that use it and its label. */
export interface SignPlan {
  readonly east: number;
  readonly north: number;
  /** A concentration sign (union of sports, over a group of tracks) or a trail sign (one named track, all its sports). */
  readonly family: SignFamily;
  /** In ActivitySchema.options order. */
  readonly activities: readonly Activity[];
  readonly label: string;
  /** Distinct tracks under this sign. */
  readonly trackCount: number;
  /** Place signs only (#61): the place name, drawn in bold above the trail count. Absent on every other sign. */
  readonly place?: string;
  /** Place signs only: the seed id of the place, so the hero sign can claim its own. */
  readonly placeId?: string;
}

/** The place whose sign is the MAIN sign, rendered as a DOM element by src/ui/hero-sign.ts instead of a sprite (#63). */
export const HERO_PLACE_ID = 'spirit-mountain-adventure-park';

/** What the hero sign needs to render one planned place sign. */
export interface PlacePlan {
  readonly id: string;
  readonly name: string;
  readonly trailCount: number;
  /** In ActivitySchema.options order. */
  readonly activities: readonly Activity[];
}

/** The place signs among `plans`, as PlacePlans. Pure. */
export function placePlans(plans: readonly SignPlan[]): PlacePlan[] {
  return plans.flatMap((p) =>
    p.placeId === undefined || p.place === undefined
      ? []
      : [{ id: p.placeId, name: p.place, trailCount: p.trackCount, activities: p.activities }],
  );
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
 * The signs for the visible areas. Areas group into tracks by trackKey. Places define concentrations first (#61): every
 * verified, positioned place of a PLACE_SIGN_KINDS kind owns the tracks whose length-weighted centroid is within
 * CATCHMENT_M of it (the nearest place wins, a tie goes to the earlier place in the list), and gets one sign at its
 * position with the place name, the union of its tracks' sports and `N trails`. A place with no member track shows no
 * sign. The tracks no place owns group into concentrations (concentrateTracks); one sign sits at the weighted centroid
 * of every vertex of the concentration. A concentration of more than SPLIT_TRACKS tracks and a plan extent over
 * SPLIT_EXTENT_M splits in two (splitInTwo), each half taking the tracks that have a vertex in it, so one trail running
 * through both halves shows on both signs. Its label is the track name for one track, else `N trails`. Output order is
 * by east, then north, so it is stable across runs.
 */
export function planSigns(
  areas: readonly TrackArea[],
  annotations: ReadonlyMap<string, Annotation>,
  selected: ReadonlySet<Activity>,
  visibleIds: ReadonlySet<string>,
  places: readonly Place[] = [],
): SignPlan[] {
  const byKey = new Map<string, TrackArea[]>();
  for (const area of areas) {
    if (!visibleIds.has(area.id)) continue;
    const key = trackKey(area);
    const members = byKey.get(key);
    if (members) members.push(area);
    else byKey.set(key, [area]);
  }
  const keys = [...byKey.keys()].sort(codePointCompare);
  const members = keys.map((key) =>
    (byKey.get(key) as TrackArea[]).slice().sort((a, b) => codePointCompare(a.id, b.id)),
  );
  const tracks: TrackPoints[] = keys.map((key, i) => ({
    key,
    points: (members[i] as TrackArea[]).flatMap((a) => areaVertices(a.geometry)),
  }));
  const activities = members.map((m) => trackActivities(m, annotations, selected));
  const labelOf = (indices: readonly number[]): string => {
    if (indices.length > 1) return `${indices.length} trails`;
    const first = (members[indices[0] as number] as TrackArea[])[0] as TrackArea;
    const sport =
      (activities[indices[0] as number] as Activity[])[0] ?? KIND_DEFAULT_ACTIVITY[first.kind];
    return trackName(first) ?? signGlyph(sport as Activity).label;
  };
  const plans: SignPlan[] = [];
  const unionOf = (indices: readonly number[]): Activity[] => {
    const union = new Set(indices.flatMap((i) => activities[i] as Activity[]));
    return ActivitySchema.options.filter((a) => union.has(a));
  };

  // 1. Places claim tracks (#61).
  const signPlaces = places.filter(
    (p) => p.verified && p.east !== null && p.north !== null && PLACE_SIGN_KINDS.has(p.kind),
  );
  const owned = signPlaces.map((): number[] => []);
  const leftover: number[] = [];
  tracks.forEach((track, t) => {
    const centre = weightedCentroid(track.points);
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    signPlaces.forEach((place, p) => {
      const distance = Math.hypot(
        centre.east - (place.east as number),
        centre.north - (place.north as number),
      );
      // Strictly nearer wins, so an equal distance stays with the earlier place.
      if (distance <= CATCHMENT_M && distance < bestDistance) {
        best = p;
        bestDistance = distance;
      }
    });
    if (best === -1) leftover.push(t);
    else (owned[best] as number[]).push(t);
  });
  signPlaces.forEach((place, p) => {
    const indices = owned[p] as number[];
    if (indices.length === 0) return;
    plans.push({
      east: place.east as number,
      north: place.north as number,
      family: 'concentration',
      activities: unionOf(indices),
      label: `${indices.length} ${indices.length === 1 ? 'trail' : 'trails'}`,
      trackCount: indices.length,
      place: place.name,
      placeId: place.id,
    });
  });

  // 2. The tracks no place owns cluster as before.
  const emit = (indices: readonly number[], points: readonly WeightedPoint[]): void => {
    if (indices.length === 0 || points.length === 0) return;
    plans.push({
      ...weightedCentroid(points),
      family: 'concentration',
      activities: unionOf(indices),
      label: labelOf(indices),
      trackCount: indices.length,
    });
  };
  const leftTracks = leftover.map((t) => tracks[t] as TrackPoints);
  for (const localGroup of concentrateTracks(leftTracks)) {
    const group = localGroup.map((l) => leftover[l] as number);
    const all = group.flatMap((t) => (tracks[t] as TrackPoints).points);
    if (group.length > SPLIT_TRACKS && planExtent(all) > SPLIT_EXTENT_M) {
      const ownedPoints: OwnedPoint[] = group.flatMap((t) =>
        (tracks[t] as TrackPoints).points.map((p) => ({ ...p, track: t })),
      );
      const seedTrack = group[0] as number;
      const [a, b] = splitInTwo(
        ownedPoints,
        weightedCentroid((tracks[seedTrack] as TrackPoints).points),
      );
      if (a.length > 0 && b.length > 0) {
        for (const half of [a, b]) {
          emit(
            [...new Set(half.map((p) => p.track))].sort((x, y) => x - y),
            half,
          );
        }
        continue;
      }
    }
    emit(group, all);
  }
  return plans.sort((a, b) => a.east - b.east || a.north - b.north);
}

// ---- trail signs (#55, #60): one sign per named track ----

/** An ordered polyline of a track's merged segments, in local metres. */
export type TrackPath = readonly PlanePoint[];

/**
 * Chains the line segments of one track into a single path. Start: the free endpoint (no other segment's endpoint
 * within FREE_ENDPOINT_TOLERANCE_M) lowest by east then north, else the first vertex of the smallest-id segment. Then
 * repeatedly append the unused segment with an endpoint nearest the path tail, flipped to meet it (a gap becomes a
 * straight connector, counted in the length). Polygons contribute their outer ring as a line.
 */
export function mergeTrackPath(areas: readonly TrackArea[]): TrackPath {
  const sorted = areas.slice().sort((a, b) => codePointCompare(a.id, b.id));
  const segments: PlanePoint[][] = sorted.map((a) =>
    areaVertices(a.geometry).map(({ east, north }) => ({ east, north })),
  );
  const endsOf = (s: readonly PlanePoint[]): PlanePoint[] => [
    s[0] as PlanePoint,
    s[s.length - 1] as PlanePoint,
  ];
  const free: PlanePoint[] = [];
  segments.forEach((s, i) => {
    for (const e of endsOf(s)) {
      const joined = segments.some(
        (o, j) =>
          j !== i && endsOf(o).some((p) => planeDistance(p, e) <= FREE_ENDPOINT_TOLERANCE_M),
      );
      if (!joined) free.push(e);
    }
  });
  free.sort((a, b) => a.east - b.east || a.north - b.north);
  const used = segments.map(() => false);
  const path: PlanePoint[] = [];
  const first = free[0];
  let startIndex = 0;
  let reversed = false;
  if (first) {
    startIndex = segments.findIndex((s) => endsOf(s).some((e) => e === first));
    reversed = (segments[startIndex] as PlanePoint[])[0] !== first;
  }
  const take = (index: number, flip: boolean): void => {
    used[index] = true;
    const s = (segments[index] as PlanePoint[]).slice();
    path.push(...(flip ? s.reverse() : s));
  };
  take(startIndex, reversed);
  for (;;) {
    const tail = path[path.length - 1] as PlanePoint;
    let best = -1;
    let bestFlip = false;
    let bestDistance = Infinity;
    segments.forEach((s, i) => {
      if (used[i]) return;
      const [a, b] = endsOf(s) as [PlanePoint, PlanePoint];
      const da = planeDistance(tail, a);
      const db = planeDistance(tail, b);
      if (da < bestDistance) [best, bestFlip, bestDistance] = [i, false, da];
      if (db < bestDistance) [best, bestFlip, bestDistance] = [i, true, db];
    });
    if (best < 0) break;
    take(best, bestFlip);
  }
  return path;
}

/** The point at `fraction` (0 to 1) of the path's length. A zero-length path returns its first point. */
export function pointAlong(path: TrackPath, fraction: number): PlanePoint {
  const first = path[0];
  if (first === undefined) throw new Error('pointAlong: empty path');
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += planeDistance(path[i - 1] as PlanePoint, path[i] as PlanePoint);
  }
  if (total === 0) return first;
  let remaining = total * fraction;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as PlanePoint;
    const b = path[i] as PlanePoint;
    const length = planeDistance(a, b);
    if (length >= remaining && length > 0) {
      const t = remaining / length;
      return { east: a.east + t * (b.east - a.east), north: a.north + t * (b.north - a.north) };
    }
    remaining -= length;
  }
  return path[path.length - 1] as PlanePoint;
}

/**
 * Trail signs: one sign per named track (name or route:name) at the midpoint of its merged length, carrying every
 * activity the track has after the filter in ActivitySchema order. Output order is by track key, so it is stable
 * across runs.
 */
export function planTrailSigns(
  areas: readonly TrackArea[],
  annotations: ReadonlyMap<string, Annotation>,
  selected: ReadonlySet<Activity>,
  visibleIds: ReadonlySet<string>,
): SignPlan[] {
  const byKey = new Map<string, TrackArea[]>();
  for (const area of areas) {
    if (!visibleIds.has(area.id) || trackName(area) === null) continue;
    const key = trackKey(area);
    const members = byKey.get(key);
    if (members) members.push(area);
    else byKey.set(key, [area]);
  }
  const plans: SignPlan[] = [];
  for (const key of [...byKey.keys()].sort(codePointCompare)) {
    const members = byKey.get(key) as TrackArea[];
    plans.push({
      ...pointAlong(mergeTrackPath(members), 0.5),
      family: 'trail',
      activities: trackActivities(members, annotations, selected),
      label: trackName(members[0] as TrackArea) as string,
      trackCount: 1,
    });
  }
  return plans;
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

/** Full canvas height of a sign texture: the panel, plus the tail for a trail sign. */
export function signCanvasHeight(family: SignFamily): number {
  return family === 'trail' ? SIGN_CANVAS_HEIGHT + TAIL_PX : SIGN_CANVAS_HEIGHT;
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
  /** Lower wins a tie in distance; absent is 0. */
  readonly priority?: number;
}

/** Gap kept between two shown signs, in CSS pixels. */
export const SIGN_GAP_PX = 4;

/**
 * Screen-space declutter: lowest priority number first (concentration and place signs, 0, before trail signs, 1), then
 * nearest first within a priority, then input order. A sign is shown only when its rect (plus SIGN_GAP_PX) overlaps no
 * sign already shown, so a trail sign yields to any concentration or place sign, however near it is. Returns one flag per input, in input order.
 */
export function declutter(rects: readonly ScreenRect[]): boolean[] {
  const order = rects
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = rects[a] as ScreenRect;
      const rb = rects[b] as ScreenRect;
      return (ra.priority ?? 0) - (rb.priority ?? 0) || ra.distance - rb.distance || a - b;
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

/** The declutter pass runs at most this often. */
export const DECLUTTER_INTERVAL_MS = 150;
/** ...and only after the camera moves more than this many degrees... */
export const DECLUTTER_MOVE_DEG = 0.5;
/** ...or this many metres (or while a hidden sign is still serving its hold). */
export const DECLUTTER_MOVE_M = 2;
/** A visible sign hides only when a higher-ranked visible sign covers more than this fraction of its area. */
export const DECLUTTER_HIDE_OVERLAP = 0.25;
/** A hidden sign shows only after this long clear of every higher-ranked visible sign, over consecutive passes. */
export const DECLUTTER_SHOW_HOLD_MS = 600;
/** A visibility change fades opacity over this long. */
export const SIGN_FADE_MS = 220;

/** One sign's hysteresis state across declutter passes. */
export interface DeclutterState {
  readonly visible: boolean;
  /** Consecutive clear time banked while hidden; reset to 0 by any overlap. */
  readonly clearMs: number;
}

/** A new sign starts hidden with its hold already served, so the first clear pass shows it. */
export const initialDeclutterState = (): DeclutterState => ({
  visible: false,
  clearMs: DECLUTTER_SHOW_HOLD_MS,
});

const overlapArea = (a: ScreenRect, b: ScreenRect, gap: number): number => {
  const w = Math.min(a.x + a.w + gap, b.x + b.w) - Math.max(a.x - gap, b.x);
  const h = Math.min(a.y + a.h + gap, b.y + b.h) - Math.max(a.y - gap, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * One declutter pass with hysteresis (Graham, 2026-10-08: signs should be "less eager to appear/disappear"). Signs are
 * ranked as in declutter (priority, then distance, then input order) and `states` is index-aligned with `rects`.
 * A visible sign hides only when a higher-ranked visible sign overlaps more than DECLUTTER_HIDE_OVERLAP of its area; a
 * hidden sign banks `dtMs` of clear time per pass that finds no higher-ranked visible sign within SIGN_GAP_PX of it and
 * shows once the bank reaches DECLUTTER_SHOW_HOLD_MS; any overlap empties the bank. Pure: returns new states.
 * `fixed` (#66) is the hero sign's screen rect: an occupied rect ranked above every sprite, so it hides an overlapping
 * visible sign by the same threshold and holds back a hidden one; null or absent changes nothing.
 */
export function declutterStep(
  rects: readonly ScreenRect[],
  states: readonly DeclutterState[],
  dtMs: number,
  fixed: ScreenRect | null = null,
): DeclutterState[] {
  const order = rects
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = rects[a] as ScreenRect;
      const rb = rects[b] as ScreenRect;
      return (ra.priority ?? 0) - (rb.priority ?? 0) || ra.distance - rb.distance || a - b;
    });
  const next: DeclutterState[] = states.map((st) => st);
  const kept: ScreenRect[] = fixed === null ? [] : [fixed];
  for (const i of order) {
    const r = rects[i] as ScreenRect;
    const st = states[i] as DeclutterState;
    const own = r.w * r.h;
    if (st.visible) {
      const covered = kept.reduce((m, k) => Math.max(m, overlapArea(r, k, 0)), 0);
      if (own > 0 && covered / own > DECLUTTER_HIDE_OVERLAP) {
        next[i] = { visible: false, clearMs: 0 };
      } else {
        kept.push(r);
      }
    } else {
      const clear = kept.every((k) => overlapArea(r, k, SIGN_GAP_PX) === 0);
      const banked = clear ? st.clearMs + dtMs : 0;
      if (clear && banked >= DECLUTTER_SHOW_HOLD_MS) {
        next[i] = { visible: true, clearMs: 0 };
        kept.push(r);
      } else {
        next[i] = { visible: false, clearMs: banked };
      }
    }
  }
  return next;
}

/** Moves `fade` (0 to 1) toward its target by dtMs / SIGN_FADE_MS. */
export function stepFade(fade: number, visible: boolean, dtMs: number): number {
  const step = dtMs / SIGN_FADE_MS;
  return visible ? Math.min(1, fade + step) : Math.max(0, fade - step);
}

/** Where the camera was at the last declutter pass. */
export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit view direction. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** True when the camera moved more than DECLUTTER_MOVE_M metres or turned more than DECLUTTER_MOVE_DEG degrees. */
export function cameraMoved(prev: CameraPose | null, cur: CameraPose): boolean {
  if (prev === null) return true;
  if (Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z) > DECLUTTER_MOVE_M) return true;
  const dot = Math.min(1, Math.max(-1, cur.dx * prev.dx + cur.dy * prev.dy + cur.dz * prev.dz));
  return (Math.acos(dot) * 180) / Math.PI > DECLUTTER_MOVE_DEG;
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
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
}

export interface SignSpec {
  /** Drawn as one chip each, in ActivitySchema.options order whatever the input order. */
  readonly activities: readonly Activity[];
  readonly label: string;
  readonly family: SignFamily;
  /** Concentration signs: a place name drawn in bold above `label`, which then becomes the smaller second line. */
  readonly place?: string | undefined;
  /** False until the Material Symbols font has loaded (or forever when it fails): chips and label only. */
  readonly glyph: boolean;
  /** The panel's size; a trail sign's canvas is TAIL_PX taller than `height`. */
  readonly width: number;
  readonly height: number;
}

const cssHex = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

/** Cache key of a sign texture: the same activities, label and role draw the same pixels. */
export const signTextureKey = (
  spec: Pick<SignSpec, 'activities' | 'label' | 'family' | 'place'>,
): string => `${spec.family}|${spec.activities.join(',')}|${spec.label}|${spec.place ?? ''}`;

/**
 * The rounded panel as one path. With `tail`, the bottom edge carries the tail's two legs in the same path (single
 * fill, no seam): leg 1 drops vertically from x = TAIL_X_FRACTION * w to the apex at (that x, h + TAIL_PX), leg 2 climbs
 * back to the bottom edge TAIL_PX * tan(15 degrees) to the right.
 */
function roundedPanel(
  ctx: SignContext2D,
  w: number,
  h: number,
  colour: number,
  tail: boolean,
): void {
  const r = h * 0.22;
  ctx.globalAlpha = SIGN_PANEL_ALPHA;
  ctx.fillStyle = cssHex(colour);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  if (tail) {
    const legX = TAIL_X_FRACTION * w;
    ctx.lineTo(legX + TAIL_PX * Math.tan((POINTER_ANGLE_DEG * Math.PI) / 180), h);
    ctx.lineTo(legX, h + TAIL_PX);
    ctx.lineTo(legX, h);
  }
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Shrinks the font until `text` fits `available`, never below 12 px. */
function fitLabel(
  ctx: SignContext2D,
  text: string,
  size: number,
  available: number,
  weight = '600',
): void {
  ctx.font = `${weight} ${size}px ${LABEL_FONT_FAMILY}`;
  const measured = ctx.measureText(text).width;
  if (measured > available && measured > 0) {
    ctx.font = `${weight} ${Math.max(12, Math.floor((size * available) / measured))}px ${LABEL_FONT_FAMILY}`;
  }
}

/** One circular chip per activity (ActivitySchema order) from `left`, centred on `y`, each holding its sport glyph. */
function drawChips(
  ctx: SignContext2D,
  spec: SignSpec,
  left: number,
  y: number,
  maxRadius: number,
  available: number,
  gap: number,
  centred = false,
): void {
  const activities = ActivitySchema.options.filter((a) => spec.activities.includes(a));
  const chipR = Math.min(
    maxRadius,
    (available - gap * Math.max(activities.length - 1, 0)) / (2 * Math.max(activities.length, 1)),
  );
  const rowWidth = activities.length * 2 * chipR + gap * Math.max(activities.length - 1, 0);
  // Centred rows sit in the middle of the `available` span that starts at `left`.
  const start = centred ? left + (available - rowWidth) / 2 : left;
  activities.forEach((activity, i) => {
    const cx = start + chipR + i * (2 * chipR + gap);
    ctx.fillStyle = cssHex(SPORT_COLOR[activity]);
    ctx.beginPath();
    ctx.arc(cx, y, chipR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    if (spec.glyph) {
      ctx.fillStyle = cssHex(labelColorFor(SPORT_COLOR[activity]));
      ctx.font = `${Math.round(chipR * 1.5)}px ${SYMBOL_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(signGlyph(activity).symbol, cx, y);
    }
  });
}

/**
 * Draws one sign on a dark neutral rounded panel at SIGN_PANEL_ALPHA. A concentration sign: top row one circular chip
 * per activity filled with SPORT_COLOR holding the sport glyph, bottom row the label in white. A trail sign: the track
 * name in bold white on top, left-aligned, one such chip per activity below it.
 */
export function drawSign(ctx: SignContext2D, spec: SignSpec): void {
  const { width: w, height: h } = spec;
  const trail = spec.family === 'trail';
  ctx.clearRect(0, 0, w, h + (trail ? TAIL_PX : 0));
  const pad = h * 0.12;
  roundedPanel(ctx, w, h, SIGN_PANEL_COLOR, trail);
  if (spec.family === 'trail') {
    ctx.fillStyle = cssHex(LABEL_LIGHT);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    fitLabel(ctx, spec.label, Math.round(h * 0.34), w - 2 * pad, 'bold');
    ctx.fillText(spec.label, pad, h * 0.25);
    drawChips(ctx, spec, pad, h * 0.7, h * TRAIL_CHIP_R_FRACTION, w - 2 * pad, h * 0.06);
    return;
  }
  if (spec.place !== undefined) {
    // A named place: chips on top, the place name in bold, then the trail count smaller underneath. The name matches a trail sign's name: 0.34 of the height, bold.
    drawChips(ctx, spec, pad, h * 0.2, h * 0.15, w - 2 * pad, h * 0.05, true);
    ctx.fillStyle = cssHex(LABEL_LIGHT);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    fitLabel(ctx, spec.place, Math.round(h * 0.34), w - 2 * pad, 'bold');
    ctx.fillText(spec.place, w / 2, h * 0.55);
    fitLabel(ctx, spec.label, Math.round(h * 0.2), w - 2 * pad);
    ctx.fillText(spec.label, w / 2, h * 0.85);
    return;
  }
  drawChips(ctx, spec, pad, h * 0.28, h * 0.2, w - 2 * pad, h * 0.06, true);
  ctx.fillStyle = cssHex(LABEL_LIGHT);
  ctx.textBaseline = 'middle';
  fitLabel(ctx, spec.label, Math.round(h * 0.32), w - 2 * pad);
  ctx.textAlign = 'center';
  ctx.fillText(spec.label, w / 2, h * 0.76);
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
  /** Named places (#61); only verified ones label a concentration sign. Defaults to none. */
  readonly places?: readonly Place[];
  /** Defaults to console.warn. */
  readonly warn?: (message: string) => void;
  /**
   * Called on every filter change and redrape with the planned place signs (#63). The hero place (HERO_PLACE_ID) gets
   * no sprite: src/ui/hero-sign.ts renders it from this plan, and a place with no member trail is absent from it.
   */
  readonly onPlan?: (places: readonly PlacePlan[]) => void;
  /** The hero sign's current screen rect in CSS pixels, or null when it is hidden (#66); sprites never sit under it. */
  readonly heroRect?: () => ScreenRect | null;
}

export interface BillboardStats {
  /** Signs of both families after the last applyFilter or redrape. */
  readonly clusterCount: number;
  /** Concentration signs after the last applyFilter or redrape. */
  readonly concentrationCount: number;
  /** Trail signs (one per named track) after the last applyFilter or redrape. */
  readonly trailCount: number;
  /** Signs carrying each activity chip after the last applyFilter or redrape. */
  readonly perSport: Readonly<Partial<Record<Activity, number>>>;
  /** Signs allocated over the layer's life (pooled). */
  readonly pooledSigns: number;
  /** Signs drawn after fade and screen-space declutter on the last frame. */
  readonly shownCount: number;
}

export interface BillboardLayer {
  readonly group: Group;
  /** Groups the visible areas into tracks and concentrations and shows both sign families. */
  applyFilter(
    annotations: ReadonlyMap<string, Annotation>,
    selected: ReadonlySet<Activity>,
    visibleIds: ReadonlySet<string>,
  ): void;
  /** Re-heights every sign from another surface. */
  redrape(active: MeshSurface): void;
  setVisible(on: boolean): void;
  stats(): BillboardStats;
  dispose(): void;
}

interface Sign {
  readonly sprite: Sprite;
  readonly material: SpriteMaterial;
  family: SignFamily;
  priority: number;
  active: boolean;
  /** Hysteresis state for the declutter pass. */
  dc: DeclutterState;
  /** Opacity multiplier, 0 to 1, easing toward the declutter target. */
  fade: number;
}

/**
 * @displayName Track sign layer
 * @strategicPurpose Lets a viewer see where each named track runs and every sport that uses it, and where sports
 *   concentrate, without hovering or reading the lines, with few enough signs that the mountain stays visible.
 * @tacticalObjective Groups visible areas into tracks and concentrations, plans concentration signs plus one sign per
 *   named track, and draws each as a pooled camera-facing, screen-sized sprite inside the ElevatedGroup (a trail
 *   sign's tail is part of its one drawn shape, apex on the trail point), compensating the group's y-scale each frame.
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
    readonly spec: Pick<SignSpec, 'activities' | 'label' | 'family' | 'place'>;
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
  const textureFor = (
    spec: Pick<SignSpec, 'activities' | 'label' | 'family' | 'place'>,
  ): CanvasTexture => {
    const key = signTextureKey(spec);
    const cached = textures.get(key);
    if (cached) return cached.texture;
    const canvas = createCanvas();
    canvas.width = SIGN_CANVAS_WIDTH;
    canvas.height = signCanvasHeight(spec.family);
    const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    const entry: SignTexture = { canvas, texture, spec };
    textures.set(key, entry);
    paint(entry);
    return texture;
  };

  const pool: Sign[] = [];
  const makeSign = (plan: SignPlan): Sign => {
    const material = new SpriteMaterial({
      map: textureFor(plan),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = SIGN_RENDER_ORDER;
    sprite.raycast = () => {};
    return {
      sprite,
      material,
      family: plan.family,
      priority: 0,
      active: false,
      dc: initialDeclutterState(),
      fade: 0,
    };
  };

  /** Concentration: bottom-centre anchored. Trail: the tail's apex, at x = TAIL_X_FRACTION of the full canvas, bottom. */
  const arrange = (sign: Sign, family: SignFamily): void => {
    sign.family = family;
    if (family === 'trail') sign.sprite.center.set(TAIL_X_FRACTION, 0);
    else sign.sprite.center.set(0.5, 0);
    group.add(sign.sprite);
  };

  let lastArgs: {
    annotations: ReadonlyMap<string, Annotation>;
    selected: ReadonlySet<Activity>;
    visibleIds: ReadonlySet<string>;
  } = { annotations: new Map(), selected: new Set(), visibleIds: new Set() };
  let lastPlans: SignPlan[] = [];
  let shownCount = 0;
  const heightAt = (east: number, north: number): number =>
    activeSurface.sample(east, north).height;
  /** Where a trail sign's apex sits in scene space. The one place to lift it (#64 trail curtains). */
  const trailAnchor = (east: number, north: number): readonly [number, number, number] =>
    toScene(east, north, Math.max(heightAt(east, north), trailTopHeight(east, north)));

  // Declutter pacing (Graham: signs should not flicker as the camera rotates).
  let sinceMs = DECLUTTER_INTERVAL_MS;
  let lastPose: CameraPose | null = null;
  let lastSizeKey = '';
  let planDirty = true;
  let holdPending = false;

  const rebuild = (): void => {
    planDirty = true;
    const { annotations, selected, visibleIds } = lastArgs;
    // Concentration signs first: they win declutter ties and keep their pool slots across trail-sign changes.
    const concentrations = planSigns(areas, annotations, selected, visibleIds, deps.places ?? []);
    deps.onPlan?.(placePlans(concentrations));
    lastPlans = [
      ...concentrations.filter((p) => p.placeId !== HERO_PLACE_ID),
      ...planTrailSigns(areas, annotations, selected, visibleIds),
    ];
    lastPlans.forEach((plan, i) => {
      const sign = pool[i] ?? makeSign(plan);
      if (pool[i] === undefined) pool.push(sign);
      sign.active = true;
      sign.dc = initialDeclutterState();
      sign.fade = 0;
      sign.priority = plan.family === 'concentration' ? 0 : 1;
      sign.material.map = textureFor(plan);
      sign.sprite.name = `billboard:${signTextureKey(plan)}`;
      sign.sprite.userData['activities'] = plan.activities;
      sign.sprite.userData['family'] = plan.family;
      sign.sprite.userData['label'] = plan.label;
      sign.sprite.visible = true;
      arrange(sign, plan.family);
      if (plan.family === 'trail') {
        const [x, y, z] = trailAnchor(plan.east, plan.north);
        sign.sprite.position.set(x, y, z);
      } else {
        const [x, y, z] = toScene(plan.east, plan.north, heightAt(plan.east, plan.north));
        sign.sprite.position.set(x, y + SIGN_OFFSET_M, z);
      }
    });
    for (let i = lastPlans.length; i < pool.length; i++) {
      const sign = pool[i] as Sign;
      sign.active = false;
      sign.sprite.visible = false;
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
  const poseDir = new Vector3();
  const ndc = new Vector3();
  const view = new Vector3();
  const onFrame = (deltaMs = 0): void => {
    if (!group.visible) return;
    const { camera, renderer } = host;
    const viewportW = renderer.domElement.clientWidth;
    const viewportH = Math.max(renderer.domElement.clientHeight, 1);
    const tanHalf = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    const widthPx = signWidthPx(viewportW);
    const heightOf = (family: SignFamily): number =>
      (widthPx * signCanvasHeight(family)) / SIGN_CANVAS_WIDTH;
    const ys = effectiveScale(host.exaggeration);
    // Sign positions never depend on the camera; only the screen-space scale and the rects below do.
    const onScreen: Sign[] = [];
    const rects: ScreenRect[] = [];
    const alphas: number[] = [];
    for (const sign of pool) {
      if (!sign.active) continue;
      const trail = sign.family === 'trail';
      const heightPx = heightOf(sign.family);
      sign.sprite.getWorldPosition(world);
      const horizontal = Math.hypot(world.x - fadeCentre.east, world.z + fadeCentre.north);
      const alpha = fadeAlpha(horizontal);
      sign.sprite.visible = false;
      if (alpha <= 0) {
        sign.dc = initialDeclutterState();
        continue;
      }
      // View-space depth sets the pixel size of a point at any screen position; Euclidean distance overstates it off-axis.
      const d = Math.max(-view.copy(world).applyMatrix4(camera.matrixWorldInverse).z, camera.near);
      const w = widthPx * ((2 * d * tanHalf) / viewportH);
      sign.sprite.scale.set(w, (w * heightPx) / widthPx / ys, 1);
      ndc.copy(world).project(camera);
      // Behind the camera or outside the clip range: never drawn, so it occupies no screen space.
      if (ndc.z < -1 || ndc.z > 1) {
        sign.dc = initialDeclutterState();
        continue;
      }
      const cx = ((ndc.x + 1) / 2) * viewportW;
      const baseY = ((1 - ndc.y) / 2) * viewportH;
      onScreen.push(sign);
      alphas.push(alpha);
      // Concentration: the bottom-centre is the projected point, so the rect extends half a width each side and up.
      // Trail: the tail apex is, TAIL_X_FRACTION of the width from the left; the rect includes the tail.
      rects.push({
        x: trail ? cx - TAIL_X_FRACTION * widthPx : cx - widthPx / 2,
        y: baseY - heightPx,
        w: widthPx,
        h: heightPx,
        distance: d,
        priority: sign.priority,
      });
    }
    // The pass runs at most every DECLUTTER_INTERVAL_MS, and only when something could change its answer.
    sinceMs += deltaMs;
    const dir = camera.getWorldDirection(poseDir);
    const pose: CameraPose = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
    };
    const sizeKey = `${viewportW}x${viewportH}@${host.exaggeration}`;
    if (
      sinceMs >= DECLUTTER_INTERVAL_MS &&
      (planDirty || holdPending || sizeKey !== lastSizeKey || cameraMoved(lastPose, pose))
    ) {
      const next = declutterStep(
        rects,
        onScreen.map((sign) => sign.dc),
        sinceMs,
        deps.heroRect?.() ?? null,
      );
      onScreen.forEach((sign, i) => {
        sign.dc = next[i] as DeclutterState;
      });
      holdPending = next.some(
        (st) => !st.visible && st.clearMs > 0 && st.clearMs < DECLUTTER_SHOW_HOLD_MS,
      );
      sinceMs = 0;
      lastPose = pose;
      lastSizeKey = sizeKey;
      planDirty = false;
    }
    let count = 0;
    onScreen.forEach((sign, i) => {
      if (sign.dc.visible) count++;
      sign.fade = stepFade(sign.fade, sign.dc.visible, deltaMs);
      sign.material.opacity = (alphas[i] as number) * sign.fade;
      sign.sprite.visible = sign.dc.visible || sign.fade > 0;
    });
    shownCount = count;
  };
  const unsubscribe = host.onFrame(onFrame);

  // First paint: every area visible, kind-default routing. The first filter apply re-routes.
  applyFilter(new Map(), new Set(), new Set(areas.map((a) => a.id)));
  onFrame();
  // The first real frame may run a pass at once.
  sinceMs = DECLUTTER_INTERVAL_MS;

  void loadSignFont(
    fonts,
    [...new Set([...ActivitySchema.options.map((s) => signGlyph(s).symbol)])],
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
      const concentrationCount = lastPlans.filter((p) => p.family === 'concentration').length;
      return {
        clusterCount: lastPlans.length,
        concentrationCount,
        trailCount: lastPlans.length - concentrationCount,
        perSport,
        pooledSigns: pool.length,
        shownCount,
      };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const sign of pool) {
        sign.material.dispose();
      }
      for (const { texture } of textures.values()) texture.dispose();
      pool.length = 0;
      textures.clear();
      group.removeFromParent();
      group.clear();
    },
  };
}

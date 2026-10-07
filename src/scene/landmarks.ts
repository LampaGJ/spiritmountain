import type { BuildingFeature } from '../schema/building';
import type { AreaEntry } from './areas';
import type { EastNorth, Landmarks } from './views';

/** Returns the terrain height in metres at a local east/north position. */
export type HeightSampler = (east: number, north: number) => number;

function lineLength(coordinates: ReadonlyArray<ReadonlyArray<number>>): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1] as ReadonlyArray<number>;
    const b = coordinates[i] as ReadonlyArray<number>;
    total += Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number));
  }
  return total;
}

/**
 * The main lift: the lift-kind area tagged aerialway=chair_lift with the greatest 2-D polyline length.
 * base is the endpoint whose sampled terrain height is lower; null when there is no such lift.
 */
export function mainLift(
  entries: Iterable<Pick<AreaEntry, 'area'>>,
  sample: HeightSampler,
): { base: EastNorth; top: EastNorth } | null {
  let best: ReadonlyArray<ReadonlyArray<number>> | null = null;
  let bestLength = -1;
  for (const { area } of entries) {
    if (area.kind !== 'lift' || area.osmTags.aerialway !== 'chair_lift') continue;
    if (area.geometry.type !== 'LineString' || area.geometry.coordinates.length < 2) continue;
    const length = lineLength(area.geometry.coordinates);
    if (length > bestLength) {
      best = area.geometry.coordinates;
      bestLength = length;
    }
  }
  if (!best) return null;
  const first = best[0] as ReadonlyArray<number>;
  const last = best[best.length - 1] as ReadonlyArray<number>;
  const a = { east: first[0] as number, north: first[1] as number };
  const b = { east: last[0] as number, north: last[1] as number };
  return sample(a.east, a.north) <= sample(b.east, b.north)
    ? { base: a, top: b }
    : { base: b, top: a };
}

/** The building named like "Upper Chalet": the centroid of its outer ring and its height, or null when absent. */
export function upperChalet(
  features: readonly Pick<BuildingFeature, 'properties' | 'geometry'>[],
): { east: number; north: number; roofM: number } | null {
  const found = features.find(
    (f) => f.properties.name !== null && /upper chalet/i.test(f.properties.name),
  );
  const ring = found?.geometry.coordinates[0];
  if (!found || !ring) return null;
  // Rings are closed (first equals last), so drop the repeated vertex before averaging.
  const points = ring.slice(0, -1);
  if (points.length === 0) return null;
  let east = 0;
  let north = 0;
  for (const p of points) {
    east += p[0] as number;
    north += p[1] as number;
  }
  return {
    east: east / points.length,
    north: north / points.length,
    roofM: found.properties.heightM,
  };
}

/** Landmarks for the default resort view; null when there is no main lift. The chalet is left out when absent. */
export function deriveLandmarks(
  entries: Iterable<Pick<AreaEntry, 'area'>>,
  buildings: readonly Pick<BuildingFeature, 'properties' | 'geometry'>[] | null,
  sample: HeightSampler,
): Landmarks | null {
  const lift = mainLift(entries, sample);
  if (!lift) return null;
  const chalet = buildings ? upperChalet(buildings) : null;
  return {
    liftBase: lift.base,
    liftTop: lift.top,
    ...(chalet ? { upperChalet: chalet } : {}),
  };
}

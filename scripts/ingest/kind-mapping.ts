import type { AreaKind } from '../../src/schema/area';

/** Why an element could not be mapped to an area kind. */
export type KindDropReason = 'unmapped-piste-type' | 'unmapped-tags';

/** Result of mapping one set of OSM tags. */
export type KindMapping =
  | { ok: true; kind: AreaKind; difficulty: string | null }
  | { ok: false; reason: KindDropReason; detail: string };

const PISTE_KINDS: Readonly<Record<string, AreaKind>> = {
  downhill: 'downhill-run',
  snow_park: 'snow-park',
  nordic: 'nordic-trail',
};

const LIFT_VALUES: readonly string[] = [
  'chair_lift',
  'mixed_lift',
  'gondola',
  'cable_car',
  'drag_lift',
  't-bar',
  'j-bar',
  'platter',
  'rope_tow',
  'magic_carpet',
];

/**
 * OSM attraction=* values that are rides. Zoo exhibits (animal) and the river train are not Spirit Mountain rides, so they stay unmapped
 * and are reported as drops. The alpine coaster is tagged roller_coaster=track, not attraction=*, and is matched separately.
 */
const ATTRACTION_RIDE_VALUES: readonly string[] = [
  'amusement_ride',
  'big_wheel',
  'bumper_car',
  'bungee_jumping',
  'carousel',
  'dark_ride',
  'drop_tower',
  'kiddie_ride',
  'log_flume',
  'maze',
  'river_rafting',
  'roller_coaster',
  'summer_toboggan',
  'swing_carousel',
  'water_slide',
];

/** The geometry each kind must end up with: a trail line, a boundary polygon, or either (the attraction a ride track or a footprint). */
export const GEOMETRY_RULE: Readonly<Record<AreaKind, 'LineString' | 'Polygon' | 'either'>> = {
  'downhill-run': 'either',
  'nordic-trail': 'either',
  'mtb-trail': 'either',
  lift: 'either',
  'snow-park': 'either',
  'mtb-route': 'either',
  'hiking-trail': 'either',
  'tubing-run': 'LineString',
  'zip-line': 'LineString',
  campground: 'Polygon',
  climbing: 'Polygon',
  attraction: 'either',
};

/** Kinds whose lone OSM node is promoted to a small octagon (the areas transform says so in osmTags). */
export const POINT_PROMOTED_KINDS: readonly AreaKind[] = ['campground', 'climbing'];

/**
 * @displayName OSM tags to area kind
 * @strategicPurpose One pure, testable rule table that turns raw OSM tags into the scene's closed set of area kinds, so no kind is ever guessed elsewhere.
 * @tacticalObjective Returns kind and difficulty by first match in this order: piste:type (downhill, snow_park, nordic), aerialway in the lift list, aerialway=zip_line, mtb:scale, route=mtb, route=hiking, tourism=camp_site, sport=climbing or any climbing tag, roller_coaster=track or a ride-valued attraction tag; otherwise returns the drop reason and a detail naming the offending tag.
 */
export function mapKind(tags: Readonly<Record<string, string>>): KindMapping {
  const piste = tags['piste:type'];
  const pisteKind = piste === undefined ? undefined : PISTE_KINDS[piste];
  if (pisteKind !== undefined) {
    return { ok: true, kind: pisteKind, difficulty: tags['piste:difficulty'] ?? null };
  }
  const aerialway = tags['aerialway'];
  if (aerialway !== undefined && LIFT_VALUES.includes(aerialway)) {
    return { ok: true, kind: 'lift', difficulty: null };
  }
  if (aerialway === 'zip_line') {
    return { ok: true, kind: 'zip-line', difficulty: null };
  }
  const scale = tags['mtb:scale'];
  if (scale !== undefined) {
    return { ok: true, kind: 'mtb-trail', difficulty: scale };
  }
  if (tags['route'] === 'mtb') {
    return { ok: true, kind: 'mtb-route', difficulty: null };
  }
  if (tags['route'] === 'hiking') {
    return { ok: true, kind: 'hiking-trail', difficulty: null };
  }
  if (tags['tourism'] === 'camp_site') {
    return { ok: true, kind: 'campground', difficulty: null };
  }
  if (tags['sport'] === 'climbing' || tags['climbing'] !== undefined) {
    return { ok: true, kind: 'climbing', difficulty: null };
  }
  const attraction = tags['attraction'];
  if (
    tags['roller_coaster'] === 'track' ||
    (attraction !== undefined && ATTRACTION_RIDE_VALUES.includes(attraction))
  ) {
    return { ok: true, kind: 'attraction', difficulty: null };
  }
  if (piste !== undefined) {
    return { ok: false, reason: 'unmapped-piste-type', detail: `piste:type=${piste}` };
  }
  if (aerialway !== undefined) {
    return { ok: false, reason: 'unmapped-tags', detail: `aerialway=${aerialway}` };
  }
  if (attraction !== undefined) {
    return { ok: false, reason: 'unmapped-tags', detail: `attraction=${attraction}` };
  }
  return { ok: false, reason: 'unmapped-tags', detail: 'no-recognised-tag' };
}

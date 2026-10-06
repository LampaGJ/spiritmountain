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
 * @displayName OSM tags to area kind
 * @strategicPurpose One pure, testable rule table that turns raw OSM tags into the scene's closed set of area kinds, so no kind is ever guessed elsewhere.
 * @tacticalObjective Returns kind and difficulty by first match in this order: piste:type (downhill, snow_park, nordic), aerialway in the lift list, mtb:scale, route=mtb; otherwise returns the drop reason and a detail naming the offending tag.
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
  const scale = tags['mtb:scale'];
  if (scale !== undefined) {
    return { ok: true, kind: 'mtb-trail', difficulty: scale };
  }
  if (tags['route'] === 'mtb') {
    return { ok: true, kind: 'mtb-route', difficulty: null };
  }
  if (piste !== undefined) {
    return { ok: false, reason: 'unmapped-piste-type', detail: `piste:type=${piste}` };
  }
  if (aerialway !== undefined) {
    return { ok: false, reason: 'unmapped-tags', detail: `aerialway=${aerialway}` };
  }
  return { ok: false, reason: 'unmapped-tags', detail: 'no-recognised-tag' };
}

import type { AreaKind } from '../schema/area';

/**
 * Terrain base colours. Owner: issue #12 (so the contrast test is self-contained).
 * Consumer: issue #11, which lerps flat to steep by slope when it writes vertex colours.
 * Lighting darkens or lightens the displayed colour; the contrast test uses these base values.
 */
export const TERRAIN_FLAT_COLOR = 0x2c3829;
export const TERRAIN_STEEP_COLOR = 0x413d31;

/**
 * Line colour per area kind. Typed as Record<AreaKind, number>, so a new kind in AreaSchema is a
 * compile error here. Starts from the Okabe-Ito set, lightened so each colour reaches 3:1
 * contrast against both terrain colours. Colour carries kind and nothing else.
 */
export const AREA_KIND_COLOR: Record<AreaKind, number> = {
  'downhill-run': 0xff7a3d,
  'nordic-trail': 0x56b4e9,
  'mtb-trail': 0x2fc795,
  lift: 0xf0e442,
  'snow-park': 0xe58fc1,
  'mtb-route': 0xb9a0f5,
};

/**
 * Line width in CSS pixels (LineMaterial linewidth with worldUnits false). Thin on purpose: the trail ribbons carry the
 * pattern, and the Line2 stays visible as the kind colour, the highlight and the pick target (see LINE2_PICK_THRESHOLD_PX).
 */
export const LINE_WIDTH_PX = 2;

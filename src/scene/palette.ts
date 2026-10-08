import type { Activity } from './sport-routing';

/**
 * Terrain base colours. Owner: issue #12 (so the contrast test is self-contained).
 * Consumer: issue #11, which lerps flat to steep by slope when it writes vertex colours.
 * Lighting darkens or lightens the displayed colour; the contrast test uses these base values.
 */
export const TERRAIN_FLAT_COLOR = 0x2c3829;
export const TERRAIN_STEEP_COLOR = 0x413d31;

/**
 * Line colour per sport (#40). Typed as Record<Activity, number>, so a new activity in ActivitySchema is a compile
 * error here. Every colour reaches 3:1 contrast against both terrain colours, sits at least 15 CIEDE2000 from every
 * other sport and from HIGHLIGHT_COLOR (src/scene/highlight.ts), so no sport is near-white. lift-ride keeps the old
 * lift yellow. The single source of trail colour; billboards and buttons (#42, #43) read it too.
 */
export const SPORT_COLOR: Record<Activity, number> = {
  'alpine-ski': 0xff6a1a,
  snowboard: 0xff3b4a,
  'nordic-classic': 0x3d8bff,
  'nordic-skate': 0x18d4e6,
  snowshoe: 0xe8beff,
  'fat-bike': 0xff4fa3,
  'mountain-bike': 0xffa21a,
  hike: 0x5fb449,
  'trail-run': 0x85ff40,
  tubing: 0x9f6aff,
  'lift-ride': 0xf0e442,
  adaptive: 0x11e0b9,
  'zip-line': 0xffbbaa,
  camping: 0xaa9944,
  climbing: 0x999999,
  'alpine-coaster': 0xbbccaa,
};

/**
 * Line width in CSS pixels (LineMaterial linewidth with worldUnits false). The Line2 is the only trail marker: it carries
 * the sport colour, the highlight and the pick target (see LINE2_PICK_THRESHOLD_PX).
 */
export const LINE_WIDTH_PX = 2;

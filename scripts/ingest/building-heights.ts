import type { BuildingHeightSource } from '../../src/schema/building';

/**
 * Type table of extrusion heights in metres, keyed by the building value (or man_made value). The values come from the
 * issue #23 probe: only 2 of 2,679 ways carry height or building:levels, so the type decides the height almost everywhere.
 */
export const TYPE_HEIGHTS_M: Readonly<Record<string, number>> = {
  detached: 7,
  house: 7,
  semidetached_house: 7,
  garage: 3.5,
  garages: 3.5,
  shed: 3.5,
  roof: 3.5,
  commercial: 8,
  retail: 8,
  apartments: 8,
  yes: 8,
  church: 12,
  tower: 20,
  mast: 20,
  water_tower: 15,
  storage_tank: 6,
};
export const DEFAULT_HEIGHT_M = 6;
export const METRES_PER_LEVEL = 3;
const METRES_PER_FOOT = 0.3048;

const HEIGHT_PATTERN = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(m|meters?|metres?|ft|feet|')?\s*$/i;

/** Rounds to centimetres, the precision the serializer writes. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * @displayName OSM height parser
 * @strategicPurpose Reads the free-text OSM height tag without trusting its units, so "12 m", "12.5" and "40 ft" all mean what the mapper meant.
 * @tacticalObjective Returns metres for a positive number optionally followed by m, meters, metres (metres), or ft, feet, ' (feet times 0.3048); returns null for anything else, including zero.
 */
export function parseHeightMetres(text: string | undefined): number | null {
  if (text === undefined) return null;
  const match = HEIGHT_PATTERN.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  const metres = unit === 'm' || unit.startsWith('met') ? value : value * METRES_PER_FOOT;
  return metres > 0 ? round2(metres) : null;
}

/** building:levels as a positive integer, or null for absent, fractional, zero or non-numeric text. */
export function parseLevels(text: string | undefined): number | null {
  if (text === undefined || !/^\s*\d+\s*$/.test(text)) return null;
  const levels = Number(text);
  return levels > 0 ? levels : null;
}

/** The kind of a feature: the raw building value, else the man_made value, else null when it carries neither. */
export function kindOf(tags: Readonly<Record<string, string>>): string | null {
  const building = tags['building'];
  if (building !== undefined && building !== '') return building;
  const manMade = tags['man_made'];
  return manMade !== undefined && manMade !== '' ? manMade : null;
}

export interface HeightResult {
  heightM: number;
  levels: number | null;
  source: BuildingHeightSource;
}

/**
 * @displayName Building height rule
 * @strategicPurpose One deterministic rule that gives every footprint an extrusion height when OSM almost never records one.
 * @tacticalObjective Returns the height tag in metres when parseable, else building:levels times 3, else the type table by kind, else 6 m, with the source named; levels is reported whenever building:levels parses.
 */
export function heightOf(tags: Readonly<Record<string, string>>): HeightResult {
  const levels = parseLevels(tags['building:levels']);
  const tagged = parseHeightMetres(tags['height']);
  if (tagged !== null) return { heightM: tagged, levels, source: 'height' };
  if (levels !== null)
    return { heightM: round2(levels * METRES_PER_LEVEL), levels, source: 'levels' };
  const kind = kindOf(tags);
  const table = kind === null ? undefined : TYPE_HEIGHTS_M[kind];
  return { heightM: table ?? DEFAULT_HEIGHT_M, levels, source: 'type-table' };
}

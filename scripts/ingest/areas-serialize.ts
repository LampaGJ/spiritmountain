import type { AreaFeatureCollection } from '../../src/schema/area';
import type { AreasReplay } from './areas-replay-schema';

/** A JSON value whose objects keep an explicit key order (a JS object cannot: integer-like keys such as "2" always sort first). */
export type JsonNode = null | boolean | number | string | readonly JsonNode[] | JsonObject;
export interface JsonObject {
  readonly entries: ReadonlyArray<readonly [string, JsonNode]>;
}

/** Builds an ordered object node from [key, value] pairs, in the order given. */
export function obj(entries: ReadonlyArray<readonly [string, JsonNode]>): JsonObject {
  return { entries };
}

/** Rounds a metre value to 2 decimals (centimetres). Math.round on a finite double is exact IEEE-754 arithmetic. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isObject(node: JsonNode): node is JsonObject {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`NonFiniteNumber: ${String(value)} cannot be serialized`);
  }
  return Object.is(value, -0) ? '0' : String(value);
}

function write(node: JsonNode, indent: string): string {
  if (node === null) return 'null';
  if (typeof node === 'number') return writeNumber(node);
  if (typeof node === 'string' || typeof node === 'boolean') return JSON.stringify(node);
  const inner = `${indent}  `;
  if (Array.isArray(node)) {
    const items = node as readonly JsonNode[];
    if (items.length === 0) return '[]';
    if (items.every((item) => typeof item === 'number')) {
      return `[${items.map((item) => write(item, inner)).join(', ')}]`;
    }
    return `[\n${items.map((item) => `${inner}${write(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (!isObject(node)) throw new Error('unreachable JsonNode');
  if (node.entries.length === 0) return '{}';
  const lines = node.entries.map(
    ([key, value]) => `${inner}${JSON.stringify(key)}: ${write(value, inner)}`,
  );
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

/**
 * @displayName Stable JSON writer
 * @strategicPurpose One fixed layout so the same data always yields the same bytes and key order never depends on JS object rules.
 * @tacticalObjective Writes 2-space-indented JSON: object keys in the given order, arrays of numbers on one line, other arrays one item per line, negative zero as 0, non-finite numbers rejected, a single LF at end of file.
 */
export function writeJson(node: JsonNode): string {
  return `${write(node, '')}\n`;
}

/**
 * @displayName Areas file serializer
 * @strategicPurpose Fixes the on-disk shape of data/areas.geojson (key order, sorted osmTags).
 * @tacticalObjective Converts a validated AreaFeatureCollection into the ordered JSON text, rounding every coordinate to 2 decimals.
 */
export function serializeAreas(collection: AreaFeatureCollection): string {
  const features = collection.features.map((feature) =>
    obj([
      ['type', 'Feature'],
      [
        'properties',
        obj([
          ['id', feature.properties.id],
          ['kind', feature.properties.kind],
          ['name', feature.properties.name],
          ['difficulty', feature.properties.difficulty],
          [
            'osmTags',
            obj(
              Object.entries(feature.properties.osmTags)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, value]) => [key, value] as const),
            ),
          ],
        ]),
      ],
      [
        'geometry',
        obj([
          ['type', feature.geometry.type],
          [
            'coordinates',
            feature.geometry.type === 'LineString'
              ? feature.geometry.coordinates.map((p) => p.map(round2))
              : feature.geometry.coordinates.map((ring) => ring.map((p) => p.map(round2))),
          ],
        ]),
      ],
    ]),
  );
  return writeJson(
    obj([
      ['type', 'FeatureCollection'],
      ['features', features],
    ]),
  );
}

/** Converts plain data to a JsonNode, keeping insertion order (safe for the replay record, whose keys are never integer-like). */
function toNode(value: unknown): JsonNode {
  if (Array.isArray(value)) return value.map(toNode);
  if (typeof value === 'object' && value !== null) {
    return obj(Object.entries(value).map(([key, item]) => [key, toNode(item)] as const));
  }
  return value as JsonNode;
}

/**
 * @displayName Areas replay serializer
 * @strategicPurpose Fixes the on-disk shape of data/areas.replay.json so its bytes are stable too.
 * @tacticalObjective Writes the validated AreasReplay in schema key order (inputHash, codeCommit, outputHash, effect, toolVersions, lockSubtreeSha256, counts, droppedCounts, dropped) with the same layout as the areas file.
 */
export function serializeReplay(replay: AreasReplay): string {
  return writeJson(toNode(replay));
}

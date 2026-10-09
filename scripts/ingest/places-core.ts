import { z } from 'zod';
import { AreaFeatureCollectionSchema, type AreaFeatureCollection } from '../../src/schema/area';
import { FrameSchema } from '../../src/schema/frame';
import {
  PlacesFileSchema,
  PlacesSeedSchema,
  type Place,
  type PlaceSeed,
  type PlacesFile,
} from '../../src/schema/places';
import { FRAME, osmToLocal } from './local-frame';
import { sha256Hex } from './replay';

/** A named, exit-coded failure of the places transform. `code` is the error name printed on stderr. */
export class PlacesError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

/** Rounds a metre value to centimetres. Math.round on a finite double is exact IEEE-754 arithmetic. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

const issueText = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

/** Parses bytes as JSON then through `schema`; a failure at either step is a named PlacesError, never a bare throw. */
function parseBytes<T>(bytes: Uint8Array, schema: z.ZodType<T>, label: string, code: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new PlacesError(
      code,
      `${label} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new PlacesError(code, `${label} failed validation: ${issueText(parsed.error)}`);
  return parsed.data;
}

type Vertex = readonly [number, number];

function verticesOf(feature: AreaFeatureCollection['features'][number]): Vertex[] {
  const g = feature.geometry;
  const positions = g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
  return positions.map((p): Vertex => [p[0], p[1]]);
}

/**
 * @displayName Resolve place anchor
 * @strategicPurpose Turns a position rule into local metres from the areas already in the repo, so an unsurveyed place is placed by derivation and never by a typed number.
 * @tacticalObjective For an area anchor finds every area with the exact name: top is the last vertex and bottom the first vertex of exactly one line (OSM way direction runs uphill for lifts), centroid is the plain mean of every vertex of every match in file order. A name that matches nothing, or an end anchor that matches several or a polygon, is a named error.
 * @manipulation preserves
 */
export function resolveAreaAnchor(
  areas: AreaFeatureCollection,
  seed: Pick<PlaceSeed, 'id'>,
  anchor: { areaName: string; at: 'top' | 'bottom' | 'centroid' },
): Vertex {
  const matches = areas.features.filter((f) => f.properties.name === anchor.areaName);
  if (matches.length === 0) {
    throw new PlacesError('AnchorAreaMissing', `${seed.id}: no area is named "${anchor.areaName}"`);
  }
  if (anchor.at === 'centroid') {
    const all = matches.flatMap(verticesOf);
    const sum = all.reduce<Vertex>((acc, v) => [acc[0] + v[0], acc[1] + v[1]], [0, 0]);
    return [sum[0] / all.length, sum[1] / all.length];
  }
  const only = matches[0];
  if (matches.length !== 1 || only === undefined || only.geometry.type !== 'LineString') {
    throw new PlacesError(
      'AnchorNotOneLine',
      `${seed.id}: "${anchor.areaName}" must be exactly one LineString for at: ${anchor.at}, found ${matches.length} match(es)`,
    );
  }
  const line = verticesOf(only);
  const end = anchor.at === 'top' ? line[line.length - 1] : line[0];
  if (end === undefined) throw new PlacesError('AnchorNotOneLine', `${seed.id}: empty line`);
  return end;
}

/**
 * @displayName Places generator
 * @strategicPurpose The whole deterministic transform from three pinned input byte arrays to the places file text: no clock, network, filesystem or git.
 * @tacticalObjective Parses the seed, areas and frame; checks frame.json equals the in-code frame; projects each coordinate row to local metres, resolves each anchored row against the areas or the named place, keeps rows with no position as unverified, gates the result with PlacesFileSchema, and returns the file text in seed order. One place out for every seed row in.
 * @manipulation preserves
 */
export function generatePlaces(input: {
  seedBytes: Uint8Array;
  areasBytes: Uint8Array;
  frameBytes: Uint8Array;
  codeCommit: string;
}): { fileText: string; file: PlacesFile; inputHash: string } {
  const seed = parseBytes(input.seedBytes, PlacesSeedSchema, 'places seed', 'SeedInvalid');
  const areas = parseBytes(
    input.areasBytes,
    AreaFeatureCollectionSchema,
    'areas file',
    'AreasInvalid',
  );
  const frame = parseBytes(input.frameBytes, FrameSchema, 'frame file', 'FrameInvalid');
  if (JSON.stringify(frame) !== JSON.stringify(FRAME)) {
    throw new PlacesError(
      'FrameMismatch',
      'data/frame.json differs from the frame in local-frame.ts',
    );
  }
  const byId = new Map(seed.map((row) => [row.id, row]));
  const places: Place[] = seed.map((row): Place => {
    let position: Vertex | null = null;
    let positionSource: Place['positionSource'] = 'none';
    if (row.lat !== null && row.lon !== null) {
      position = osmToLocal(row.lon, row.lat);
      positionSource = 'coordinates';
    } else if (row.anchor !== null) {
      positionSource = 'anchor';
      if ('placeId' in row.anchor) {
        const target = byId.get(row.anchor.placeId);
        if (target === undefined || target.lat === null || target.lon === null) {
          throw new PlacesError(
            'AnchorPlaceMissing',
            `${row.id}: placeId ${row.anchor.placeId} has no coordinates`,
          );
        }
        position = osmToLocal(target.lon, target.lat);
      } else {
        position = resolveAreaAnchor(areas, row, row.anchor);
      }
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      east: position === null ? null : round2(position[0]),
      north: position === null ? null : round2(position[1]),
      radiusM: row.radiusM,
      sourceUrl: row.sourceUrl,
      verified: row.verified,
      positionNote: row.positionNote,
      positionSource,
    };
  });
  const frameSha = sha256Hex(input.frameBytes);
  const inputHash = sha256Hex(
    `scripts/ingest/places.seed.json:${sha256Hex(input.seedBytes)}\ndata/areas.geojson:${sha256Hex(input.areasBytes)}\ndata/frame.json:${frameSha}\n`,
  );
  const candidate = {
    version: 1,
    frame: { sha256: frameSha },
    generatedFrom: { inputHash, codeCommit: input.codeCommit, effect: 'preserves' },
    places,
  };
  const gate = PlacesFileSchema.safeParse(candidate);
  if (!gate.success) throw new PlacesError('PlacesInvalid', issueText(gate.error));
  return { fileText: `${JSON.stringify(gate.data, null, 2)}\n`, file: gate.data, inputHash };
}

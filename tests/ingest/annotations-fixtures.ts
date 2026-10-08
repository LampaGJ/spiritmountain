import { readFileSync } from 'node:fs';

/** Fixed fake commit so tests never depend on the working tree's git state. */
export const FAKE_COMMIT = 'd'.repeat(40);

export const SEED_PATH = 'scripts/ingest/organizations.seed.json';

/** The real seed bytes, read from disk (the seed is a primary-source input; tests never edit it). */
export function realSeedBytes(): Uint8Array {
  return readFileSync(SEED_PATH);
}

export function realSeedRows(): Record<string, unknown>[] {
  return JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Record<string, unknown>[];
}

const line = {
  type: 'LineString',
  coordinates: [
    [0, 0, 0],
    [5, 5, 0],
  ],
};

/** One feature per area kind. Ids are deliberately out of order, and way/1000 must sort before way/999 in code-unit order. */
export const AREA_ROWS: { id: string; kind: string }[] = [
  { id: 'way/999', kind: 'downhill-run' },
  { id: 'way/1000', kind: 'nordic-trail' },
  { id: 'way/20', kind: 'mtb-trail' },
  { id: 'relation/5', kind: 'mtb-route' },
  { id: 'way/7', kind: 'lift' },
  { id: 'way/30', kind: 'snow-park' },
  { id: 'way/40', kind: 'hiking-trail' },
];

export function areasFileObject(rows = AREA_ROWS): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      properties: { id: row.id, kind: row.kind, name: null, difficulty: null, osmTags: {} },
      geometry: line,
    })),
  };
}

export function areasBytes(rows = AREA_ROWS): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(areasFileObject(rows)));
}

export function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

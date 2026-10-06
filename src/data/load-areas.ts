/**
 * @displayName Areas loader
 * @strategicPurpose Parses data/areas.geojson at the point it enters the browser, so every later
 *   consumer (#12 lines, #13 picking, #14 filters) receives typed Area values or a named failure.
 *   Seam record for #4: areas.geojson emitter_gate = #8 (validates with AreaFeatureCollectionSchema
 *   from src/schema/area.ts); consumer_gate = this file (the same strict schema, one safeParse).
 * @tacticalObjective Fetch a URL, parse the whole file once with the strict AreaFeatureCollectionSchema,
 *   recombine each feature into an Area, and throw one error naming every failing feature id.
 *   Never returns an empty array.
 */
import type { ZodError } from 'zod';
import { AreaFeatureCollectionSchema, type Area } from '../schema/area';

/** Label for features[index]: the raw properties.id when it is a string, else features[index]. */
function featureLabel(json: unknown, index: number): string {
  const features = (json as { features?: unknown } | null)?.features;
  const raw = Array.isArray(features)
    ? (features[index] as { properties?: { id?: unknown } } | null | undefined)
    : undefined;
  const id = raw?.properties?.id;
  return typeof id === 'string' ? id : `features[${index}]`;
}

/** Group zod issues by features[i] and name each failing feature; every other issue is an envelope issue. */
function describeFailures(json: unknown, error: ZodError): string {
  const byFeature = new Map<number, string[]>();
  const envelope: string[] = [];
  for (const issue of error.issues) {
    const [head, index, ...rest] = issue.path;
    if (head === 'features' && typeof index === 'number') {
      const where = rest.map(String).join('.') || '(feature)';
      byFeature.set(index, [...(byFeature.get(index) ?? []), `${where}: ${issue.message}`]);
    } else {
      envelope.push(`${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    }
  }
  const lines: string[] = [];
  if (envelope.length > 0) lines.push(`areas.geojson envelope is invalid: ${envelope.join('; ')}`);
  if (byFeature.size > 0) {
    lines.push(`areas.geojson has ${byFeature.size} invalid feature(s):`);
    for (const [index, messages] of byFeature) {
      lines.push(`${featureLabel(json, index)}: ${messages.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/** Parse an already-decoded areas.geojson value. Pure, so tests need no network. */
export function parseAreas(json: unknown): Area[] {
  const parsed = AreaFeatureCollectionSchema.safeParse(json);
  if (!parsed.success) throw new Error(describeFailures(json, parsed.error));
  return parsed.data.features.map((f): Area => ({ ...f.properties, geometry: f.geometry }));
}

/** Fetch and parse. The URL comes from a Vite ?url import or a dev override; fetchFn is for tests. */
export async function loadAreas(url: string, fetchFn: typeof fetch = fetch): Promise<Area[]> {
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`areas.geojson request failed: HTTP ${response.status} for ${url}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    throw new Error(`areas.geojson at ${url} is not JSON`, { cause });
  }
  return parseAreas(json);
}

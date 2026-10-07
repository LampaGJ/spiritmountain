/**
 * @displayName Buildings loader
 * @strategicPurpose Parses data/buildings.geojson at the point it enters the browser, so the scene
 *   extrudes typed BuildingFeature values or reports one named failure. Seam record: buildings.geojson
 *   emitter_gate = scripts/ingest/buildings.ts (BuildingFeatureCollectionSchema); consumer_gate = this file.
 * @tacticalObjective Fetch a URL, parse the whole file once with BuildingFeatureCollectionSchema, and
 *   resolve to the features or to { error } naming every failing feature id. Never resolves to an empty list.
 */
import type { ZodError } from 'zod';
import { BuildingFeatureCollectionSchema, type BuildingFeature } from '../schema/building';

export type BuildingsResult = { readonly features: BuildingFeature[] } | { readonly error: string };

function featureLabel(json: unknown, index: number): string {
  const features = (json as { features?: unknown } | null)?.features;
  const raw = Array.isArray(features)
    ? (features[index] as { properties?: { id?: unknown } } | null | undefined)
    : undefined;
  const id = raw?.properties?.id;
  return typeof id === 'string' ? id : `features[${index}]`;
}

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
  if (envelope.length > 0) lines.push(`buildings.geojson envelope is invalid: ${envelope.join('; ')}`);
  if (byFeature.size > 0) {
    lines.push(`buildings.geojson has ${byFeature.size} invalid feature(s):`);
    for (const [index, messages] of byFeature) {
      lines.push(`${featureLabel(json, index)}: ${messages.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/** Parse an already-decoded buildings.geojson value. Pure, so tests need no network. Throws on any violation. */
export function parseBuildings(json: unknown): BuildingFeature[] {
  const parsed = BuildingFeatureCollectionSchema.safeParse(json);
  if (!parsed.success) throw new Error(describeFailures(json, parsed.error));
  return parsed.data.features;
}

/** Fetch and parse. Never rejects: a failure resolves to { error }, so it can never block the terrain. */
export async function loadBuildings(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<BuildingsResult> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      return { error: `buildings.geojson request failed: HTTP ${response.status} for ${url}` };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { error: `buildings.geojson at ${url} is not JSON` };
    }
    return { features: parseBuildings(json) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

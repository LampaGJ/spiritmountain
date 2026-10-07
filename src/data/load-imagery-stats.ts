import statsUrl from '../../data/imagery-stats.json?url';
import { ImageryStatsSchema, type ImageryStats } from '../schema/imagery-stats';

export type ImageryStatsResult = ImageryStats | { readonly error: string };

/**
 * @displayName Imagery statistics loader
 * @strategicPurpose Consumer gate for data/imagery-stats.json: a renamed or missing field fails here with a named reason instead of tinting the ground plane with undefined or NaN.
 * @tacticalObjective Fetches the JSON, parses it once with ImageryStatsSchema, and resolves to the stats or to { error }. Never rejects.
 */
export async function loadImageryStats(
  url: string = statsUrl,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageryStatsResult> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return { error: `${url} returned HTTP ${response.status}` };
    const parsed = ImageryStatsSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        error: `imagery-stats.json is invalid: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      };
    }
    return parsed.data;
  } catch (error) {
    return { error: `could not load ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

import { annotationsFileForAreas } from '../schema/annotations-file';
import type { Annotation } from '../schema/annotation';
import type { Organization } from '../schema/organization';

/**
 * @displayName Annotations load error
 * @strategicPurpose Makes every annotations.json failure a named, catchable error so the UI can show a red load-failure state instead of a false "no annotation".
 * @tacticalObjective Carries a human-readable message naming the first problem found at the boundary and the total issue count.
 */
export class AnnotationsLoadError extends Error {
  override name = 'AnnotationsLoadError';
}

/**
 * @displayName Loaded annotations
 * @strategicPurpose The consumer-side view of data/annotations.json handed to the panel and the scene.
 * @tacticalObjective Holds annotations keyed by areaId, organizations keyed by id, and the area ids with no annotation.
 */
export interface LoadedAnnotations {
  readonly annotations: ReadonlyMap<string, Annotation>;
  readonly organizations: ReadonlyMap<string, Organization>;
  readonly unannotatedAreaIds: readonly string[];
}

/**
 * @displayName Parse annotations file
 * @strategicPurpose Consumer-side gate for the human-edited annotations.json (foreign-data seam; the emitter gate is #10). Delegates every check to #6's annotationsFileForAreas, so the consumer and the emitter share one reject set.
 * @tacticalObjective Parses with annotationsFileForAreas(areaIds).safeParse and throws AnnotationsLoadError carrying issues[0] and the issue count; on success returns the two maps and the unannotated area ids.
 */
export function parseAnnotations(raw: unknown, areaIds: ReadonlySet<string>): LoadedAnnotations {
  const parsed = annotationsFileForAreas(areaIds).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const first = issues[0];
    const where = first === undefined || first.path.length === 0 ? '(root)' : first.path.join('.');
    throw new AnnotationsLoadError(
      `annotations.json failed validation at ${where}: ${first?.message ?? 'unknown issue'} (${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} in total)`,
    );
  }
  const file = parsed.data;
  const annotations = new Map<string, Annotation>(file.annotations.map((annotation) => [annotation.areaId, annotation]));
  const organizations = new Map<string, Organization>(file.organizations.map((organization) => [organization.id, organization]));
  const unannotatedAreaIds = [...areaIds].filter((id) => !annotations.has(id));
  return { annotations, organizations, unannotatedAreaIds };
}

/**
 * @displayName Load annotations
 * @strategicPurpose Fetches data/annotations.json (or a fixture URL) and parses it at the boundary, never at the sink.
 * @tacticalObjective Throws AnnotationsLoadError on a network failure, non-200 response, non-JSON body, or any parseAnnotations failure.
 */
export async function loadAnnotations(
  url: string,
  areaIds: ReadonlySet<string>,
  fetchFn: typeof fetch = fetch,
): Promise<LoadedAnnotations> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (cause) {
    throw new AnnotationsLoadError(`annotations.json request failed: ${String(cause)} (${url})`);
  }
  if (!response.ok) {
    throw new AnnotationsLoadError(`annotations.json request failed: HTTP ${response.status} for ${url}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new AnnotationsLoadError(`annotations.json is not valid JSON (${url})`);
  }
  return parseAnnotations(raw, areaIds);
}

import './filters.css';
import type { AreaEntry } from '../scene/areas';
import { applyFilter } from '../scene/filter-apply';
import type { AnnotationsHandle } from '../wire-annotations';
import { SeasonSchema } from '../schema/annotation';
import { browserHash, mountFilterStrip, TOGGLE_ACTIVITIES, type FilterStrip } from './filters';
import { getRail } from './rail';
import { facetCounts } from './filter-predicate';

export interface MountFiltersDeps {
  readonly registry: ReadonlyMap<string, AreaEntry>;
  /** The #13 handle. Its `annotations.status` decides between a working strip and "filters unavailable". */
  readonly handle: AnnotationsHandle;
  /** Turns the terrain imagery on or off. Absent means no Imagery button. */
  readonly setImagery?: (on: boolean) => void;
  /** Shows or hides the buildings layer. Absent means no Buildings button. */
  readonly setBuildings?: (on: boolean) => void;
  /** Shows or hides the first-return surface layer. Absent means no Surface button. */
  readonly setSurface?: (on: boolean) => void;
  /** Shows or hides the simulated trees layer. Absent means no Trees button. */
  readonly setTrees?: (on: boolean) => void;
  /** Sets the terrain exaggeration factor (0 to 10). Absent means no slider. */
  readonly setExaggeration?: (k: number) => void;
}

/** Shown instead of the strip when the annotations load failed (#13 Decision 5). */
export const FILTERS_UNAVAILABLE_TEXT = 'filters unavailable: annotations failed to load';

export function mountFilters(deps: MountFiltersDeps): FilterStrip {
  const { registry, handle, setImagery, setBuildings, setSurface, setTrees, setExaggeration } =
    deps;
  const host = document.createElement('div');
  host.id = 'filters';
  host.className = 'sm-console';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Activity and season filters');
  getRail().appendChild(host);
  if (handle.annotations.status === 'failed') {
    // No hash-derived filter is applied and the hash is not rewritten, so the user's link survives the failure.
    host.textContent = FILTERS_UNAVAILABLE_TEXT;
    return { sync() {}, dispose() {} };
  }
  const annotations = handle.annotations.map;
  const areas = [...registry.values()].map((entry) => entry.area);
  return mountFilterStrip({
    host,
    ...browserHash,
    ...(setImagery ? { setImagery } : {}),
    ...(setBuildings ? { setBuildings } : {}),
    ...(setSurface ? { setSurface } : {}),
    ...(setTrees ? { setTrees } : {}),
    ...(setExaggeration ? { setExaggeration } : {}),
    apply: (filter) => {
      const result = applyFilter(registry, annotations, filter);
      handle.onFilterApplied(result.visibleIds);
      return {
        ...result,
        facets: facetCounts(areas, annotations, filter, TOGGLE_ACTIVITIES, SeasonSchema.options),
      };
    },
  });
}

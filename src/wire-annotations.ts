import type { Line2 } from 'three/addons/lines/Line2.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { AnnotationsLoadError, loadAnnotations } from './data/load-annotations';
import type { AreaEntry } from './scene/areas';
import { INITIAL_STATE, createHighlighter, reduce, type InteractionEvent } from './scene/highlight';
import { attachPicking } from './scene/pick';
import type { Annotation } from './schema/annotation';
import { buildPanelModel, areaTitle, type AnnotationSource } from './ui/panel-model';
import { createPanel } from './ui/panel';
import { createTooltip } from './ui/tooltip';
import './ui/panel.css';

/** The slice of the #11 scene handle and the #12 area layer this wiring needs. */
export interface WireOptions {
  readonly scene: {
    readonly camera: PerspectiveCamera;
    readonly renderer: WebGLRenderer;
    readonly controls: OrbitControls;
    onFrame(callback: () => void): void;
  };
  /** `areaLayer.registry` from src/scene/areas.ts: one AreaEntry per area, one Line2 per ring in `lines`. */
  readonly registry: ReadonlyMap<string, AreaEntry>;
  /** Brightens the walls of the highlighted area ids (AreaLayer.setWallHighlight, #74). */
  readonly setWallHighlight?: (ids: ReadonlySet<string>) => void;
  readonly annotationsUrl: string;
  readonly panelRoot: HTMLElement;
  readonly tooltipRoot: HTMLElement;
  /** Test seam; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch;
}

/**
 * @displayName Annotations load state
 * @strategicPurpose Lets #14 tell "annotations failed to load" from "loaded, some areas unannotated", so a broken load never reads as a correct empty result.
 * @tacticalObjective Either the annotation map keyed by areaId, or the load error message.
 */
export type AnnotationsState =
  | { readonly status: 'loaded'; readonly map: ReadonlyMap<string, Annotation> }
  | { readonly status: 'failed'; readonly message: string };

/**
 * @displayName Annotations handle
 * @strategicPurpose The one object other modules (#14 filters) use to read annotations and to clear hover and selection, so no one else touches the reducer or the panel.
 * @tacticalObjective Exposes the load state and the hover and selection controls; every state change goes through the interaction reducer so the highlighter resets the swapped material.
 */
export interface AnnotationsHandle {
  readonly annotations: AnnotationsState;
  /** Selects an area and opens its panel (what a click does). */
  select(areaId: string): void;
  /** Dispatches hover null and hides the tooltip and the pointer cursor. */
  clearHover(): void;
  getSelectedAreaId(): string | null;
  /** Closes through the panel's own close path, which dispatches clear-selection. */
  closePanel(): void;
  /** Called by #14 after every filter change: clears hover, and closes the panel if the selection is now hidden. */
  onFilterApplied(visibleIds: ReadonlySet<string>): void;
  dispose(): void;
}

/**
 * @displayName Failed annotations handle
 * @strategicPurpose Gives src/main.ts a handle of the same shape when the areas layer or the wiring failed, so #14 shows "filters unavailable" instead of crashing.
 * @tacticalObjective Returns status failed with the message and no-op controls.
 */
export function failedAnnotationsHandle(message: string): AnnotationsHandle {
  return {
    annotations: { status: 'failed', message },
    select() {},
    clearHover() {},
    getSelectedAreaId: () => null,
    closePanel() {},
    onFilterApplied() {},
    dispose() {},
  };
}

/**
 * @displayName Annotation wiring
 * @strategicPurpose Connects loading, picking, highlight, tooltip and panel into the running scene.
 * @tacticalObjective Loads annotations at the boundary, shows the red load-failure state on an AnnotationsLoadError while hover still works, rethrows any other error for src/main.ts to turn into a failed handle, and returns the AnnotationsHandle.
 */
export async function wireAnnotations(options: WireOptions): Promise<AnnotationsHandle> {
  const { scene, registry } = options;
  const canvas = scene.renderer.domElement;
  canvas.setAttribute('tabindex', '-1');

  const linesByAreaId = new Map<string, readonly Line2[]>();
  for (const [areaId, entry] of registry) linesByAreaId.set(areaId, entry.lines);
  const highlighter = createHighlighter(linesByAreaId, (ids) => options.setWallHighlight?.(ids));
  let state = INITIAL_STATE;
  const dispatch = (event: InteractionEvent): void => {
    state = reduce(state, event);
    highlighter.apply(state);
  };

  const panel = createPanel(options.panelRoot, () => {
    dispatch({ type: 'clear-selection' });
    canvas.focus();
  });
  const tooltip = createTooltip(options.tooltipRoot);

  let source: AnnotationSource;
  let annotations: AnnotationsState;
  try {
    const loaded = await loadAnnotations(
      options.annotationsUrl,
      new Set(registry.keys()),
      options.fetchFn,
    );
    source = {
      status: 'loaded',
      annotations: loaded.annotations,
      organizations: loaded.organizations,
    };
    annotations = { status: 'loaded', map: loaded.annotations };
    const note = `${loaded.unannotatedAreaIds.length} of ${registry.size} areas have no annotation`;
    console.warn(`annotations: ${note}`);
    panel.setFooter(note);
  } catch (error) {
    if (!(error instanceof AnnotationsLoadError)) throw error;
    console.error(error);
    source = { status: 'failed', message: error.message };
    annotations = { status: 'failed', message: error.message };
    panel.showError(error.message);
  }

  function clearHover(): void {
    dispatch({ type: 'hover', areaId: null });
    tooltip.hide();
    canvas.style.cursor = '';
  }

  function closePanel(): void {
    panel.close();
    dispatch({ type: 'clear-selection' });
  }

  function select(areaId: string): void {
    const entry = registry.get(areaId);
    if (entry === undefined) return;
    dispatch({ type: 'select', areaId });
    panel.show(buildPanelModel(entry.area, source));
  }

  const picking = attachPicking({
    canvas,
    camera: scene.camera,
    controls: scene.controls,
    onFrame: (callback) => scene.onFrame(callback),
    candidates: () => [...linesByAreaId.values()].flat(),
    onHover(areaId, clientX, clientY) {
      dispatch({ type: 'hover', areaId });
      const entry = areaId === null ? undefined : registry.get(areaId);
      if (entry === undefined) {
        tooltip.hide();
        canvas.style.cursor = '';
      } else {
        tooltip.show(areaTitle(entry.area), clientX, clientY);
        canvas.style.cursor = 'pointer';
      }
    },
    onSelect: select,
  });

  return {
    annotations,
    select,
    clearHover,
    getSelectedAreaId: () => state.selectedId,
    closePanel,
    onFilterApplied(visibleIds) {
      clearHover();
      const selectedId = state.selectedId;
      if (selectedId !== null && !visibleIds.has(selectedId)) closePanel();
    },
    dispose() {
      picking.dispose();
      panel.dispose();
    },
  };
}

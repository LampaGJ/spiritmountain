import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Line2 } from 'three/addons/lines/Line2.js';

/**
 * @displayName Interaction state
 * @strategicPurpose One small state machine for hover and selection so leaving hover restores the selected highlight, not the base material.
 * @tacticalObjective Holds the hovered area id and the selected area id, each or both possibly null.
 */
export interface InteractionState {
  readonly hoverId: string | null;
  readonly selectedId: string | null;
}

export type InteractionEvent =
  | { readonly type: 'hover'; readonly areaId: string | null }
  | { readonly type: 'select'; readonly areaId: string }
  | { readonly type: 'clear-selection' };

export const INITIAL_STATE: InteractionState = { hoverId: null, selectedId: null };

/** Pure reducer. Clicking empty terrain emits no event, so it never changes the state. */
export function reduce(state: InteractionState, event: InteractionEvent): InteractionState {
  switch (event.type) {
    case 'hover':
      return { ...state, hoverId: event.areaId };
    case 'select':
      return { ...state, selectedId: event.areaId };
    case 'clear-selection':
      return { ...state, selectedId: null };
  }
}

/** Area ids that should currently be drawn with the highlight material. */
export function highlightedIds(state: InteractionState): ReadonlySet<string> {
  const ids = new Set<string>();
  if (state.hoverId !== null) ids.add(state.hoverId);
  if (state.selectedId !== null) ids.add(state.selectedId);
  return ids;
}

/**
 * @displayName Line highlighter
 * @strategicPurpose Highlights by colour only, with linewidth identical to the base, so the swapped material does not change the line's pick region.
 * @tacticalObjective Swaps line.material between the shared per-kind material and a per-kind clone with colour HIGHLIGHT_COLOR; never mutates the shared material.
 */
export interface Highlighter {
  apply(state: InteractionState): void;
}

export const HIGHLIGHT_COLOR = 0xffffff;

/**
 * @param linesByAreaId the Line2 objects of each area (`AreaEntry.lines` from the #12 registry, one Line2 per ring)
 */
export function createHighlighter(
  linesByAreaId: ReadonlyMap<string, readonly Line2[]>,
): Highlighter {
  const highlightFor = new Map<LineMaterial, LineMaterial>();
  const baseOf = new Map<Line2, LineMaterial>();
  for (const lines of linesByAreaId.values()) {
    for (const line of lines) baseOf.set(line, line.material);
  }

  function highlightMaterial(base: LineMaterial): LineMaterial {
    let material = highlightFor.get(base);
    if (material === undefined) {
      material = base.clone();
      material.color.setHex(HIGHLIGHT_COLOR);
      highlightFor.set(base, material);
    }
    return material;
  }

  return {
    apply(state) {
      const on = highlightedIds(state);
      for (const [areaId, lines] of linesByAreaId) {
        for (const line of lines) {
          const base = baseOf.get(line);
          if (base === undefined) continue;
          if (on.has(areaId)) {
            const highlight = highlightMaterial(base);
            // Raycast returns early while resolution is 0 (LineSegments2.js:331); a fresh clone has
            // not been rendered, so copy the base's current resolution before the swap.
            highlight.resolution.copy(base.resolution);
            line.material = highlight;
          } else {
            line.material = base;
          }
        }
      }
    },
  };
}

/**
 * @displayName Pick tooltip
 * @strategicPurpose Shows the hovered area's name next to the pointer.
 * @tacticalObjective Sets textContent and fixed pixel position on one element; never builds HTML from data.
 */
export interface Tooltip {
  show(text: string, clientX: number, clientY: number): void;
  hide(): void;
}

const OFFSET_PX = 14;

export function createTooltip(element: HTMLElement): Tooltip {
  element.hidden = true;
  return {
    show(text, clientX, clientY) {
      element.textContent = text;
      element.style.left = `${Math.round(clientX + OFFSET_PX)}px`;
      element.style.top = `${Math.round(clientY + OFFSET_PX)}px`;
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
  };
}

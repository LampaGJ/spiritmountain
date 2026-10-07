import './rail.css';
import { iconSpan } from './clicky-key';
import { iconFor } from './icons';

/**
 * @displayName Control rail
 * @strategicPurpose Gives the filter console and the camera view strip one shared left-edge column, so neither sits in a box of its own and the scene shows through between keys.
 * @tacticalObjective Finds or creates the single `#rail` nav in document.body; mounters append into it and CSS `order` fixes the sequence, so mount order does not matter.
 */
export function getRail(): HTMLElement {
  const existing = document.getElementById('rail');
  if (existing !== null) return existing;
  const rail = document.createElement('nav');
  rail.id = 'rail';
  rail.className = 'sm-rail';
  rail.setAttribute('aria-label', 'Map controls');
  document.body.appendChild(rail);
  return rail;
}

/** Removes the rail when its last section has gone. */
export function releaseRail(): void {
  const rail = document.getElementById('rail');
  if (rail !== null && rail.childElementCount === 0) rail.remove();
}

/** A group header: header icon (aria-hidden) then the small uppercase label from the icon map. */
export function groupHead(iconId: string, id?: string): HTMLParagraphElement {
  const entry = iconFor(iconId);
  const head = document.createElement('p');
  head.className = 'group-head';
  if (id !== undefined) head.id = id;
  const text = document.createElement('span');
  text.className = 'group-head-text';
  text.textContent = entry.label;
  head.append(iconSpan(entry.symbol, 'ms ms-head'), text);
  return head;
}

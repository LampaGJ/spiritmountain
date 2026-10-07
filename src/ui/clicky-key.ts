import './theme.css';
import './clicky.css';

/**
 * @displayName Clicky key builders
 * @strategicPurpose One place that knows the clicky-button markup contract, so every control in the console, the views strip and the panel is the same tactile key.
 * @tacticalObjective Builds `.btn-scale > .btn-housing > .btn-cell > button` with createElement and textContent only; toggle keys carry aria-pressed, click keys are plain buttons.
 */
export interface ClickyKey {
  /** The outer `.cl-key` element to append to the page. */
  readonly root: HTMLElement;
  /** The real `<button>` that receives clicks, focus and aria state. */
  readonly button: HTMLButtonElement;
  /**
   * Shows a small count badge after the label (null removes it). The key widens to fit the badge.
   * The badge is a span inside the button, so it is part of the button's accessible name.
   */
  setCount(count: number | null): void;
}

export interface KeyOptions {
  /** Extra class on the button itself (for example `panel-close`). */
  readonly buttonClass?: string;
}

function slugOf(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function buildKey(
  scope: 'cl-t' | 'cl-c',
  buttonClass: string,
  label: string,
  options: KeyOptions,
): ClickyKey {
  const root = div(`cl-key ${scope}`);
  // The label length sizes the key (see theme.css); the font size is constant across keys.
  root.style.setProperty('--cl-chars', String(label.length));
  const scale = div('btn-scale');
  const housing = div('btn-housing');
  const cell = div('btn-cell');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = [buttonClass, `label-${slugOf(label)}`, options.buttonClass]
    .filter((c): c is string => c !== undefined && c !== '')
    .join(' ');
  const face = span('btn-face');
  face.append(span('btn-label', label));
  button.append(span('btn-wall'), face);
  cell.append(button);
  housing.append(cell);
  scale.append(housing);
  root.append(scale);
  let badge: HTMLSpanElement | null = null;
  const setCount = (count: number | null): void => {
    if (count === null) {
      badge?.remove();
      badge = null;
      root.style.setProperty('--cl-chars', String(label.length));
      return;
    }
    if (badge === null) {
      badge = span('btn-count');
      face.append(badge);
    }
    badge.textContent = String(count);
    // One extra character of room for the gap before the badge.
    root.style.setProperty('--cl-chars', String(label.length + badge.textContent.length + 1));
  };
  return { root, button, setCount };
}

/** A latching key. Its state lives in `aria-pressed`, which the generated CSS reads. */
export function createToggleKey(label: string, options: KeyOptions = {}): ClickyKey {
  const key = buildKey('cl-t', 'clicky-toggle', label, options);
  key.button.setAttribute('aria-pressed', 'false');
  return key;
}

/** A momentary key that springs back. */
export function createClickKey(label: string, options: KeyOptions = {}): ClickyKey {
  return buildKey('cl-c', 'clicky-btn', label, options);
}

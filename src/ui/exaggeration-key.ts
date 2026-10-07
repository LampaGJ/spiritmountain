import './theme.css';
import { iconSpan } from './clicky-key';

/**
 * @displayName Terrain exaggeration slider
 * @strategicPurpose The one control that scales the whole relief about lake level, built from the console's material language so it sits in the Layers group beside the toggle keys.
 * @tacticalObjective Builds a labelled native range input (icon, label, live "x1.0" value) with createElement and textContent only; arrows step 0.1 natively, a double-click resets to 1, and every change reports one number.
 */
export interface ExaggerationKey {
  /** The `.exag-key` element to append to the Layers group. */
  readonly root: HTMLElement;
  /** The native range input (focus, keyboard and pointer all go through it). */
  readonly input: HTMLInputElement;
  /** Shows a value without firing onChange (used when the hash drives the state). */
  setValue(k: number): void;
}

export const EXAGGERATION_MIN = 0;
export const EXAGGERATION_MAX = 10;
export const EXAGGERATION_STEP = 0.1;
export const EXAGGERATION_DEFAULT = 1;

/** "x1.0": the value with one decimal. */
export const formatExaggeration = (k: number): string => `x${k.toFixed(1)}`;

export interface ExaggerationKeyOptions {
  readonly icon: string;
  readonly label: string;
  /** Called with the new factor on every input event and on a double-click reset. */
  readonly onChange: (k: number) => void;
}

export function createExaggerationKey(options: ExaggerationKeyOptions): ExaggerationKey {
  const root = document.createElement('div');
  root.className = 'exag-key';
  const head = document.createElement('div');
  head.className = 'exag-head';
  const text = document.createElement('span');
  text.className = 'exag-label';
  text.textContent = options.label;
  const value = document.createElement('output');
  value.className = 'exag-value';
  head.append(iconSpan(options.icon), text, value);

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'exag-input';
  input.min = String(EXAGGERATION_MIN);
  input.max = String(EXAGGERATION_MAX);
  input.step = String(EXAGGERATION_STEP);
  input.setAttribute('aria-label', options.label);

  const show = (k: number): void => {
    input.value = String(k);
    value.textContent = formatExaggeration(k);
    input.setAttribute('aria-valuetext', formatExaggeration(k));
  };
  show(EXAGGERATION_DEFAULT);

  input.addEventListener('input', () => {
    const k = Number(input.value);
    show(k);
    options.onChange(k);
  });
  input.addEventListener('dblclick', () => {
    show(EXAGGERATION_DEFAULT);
    options.onChange(EXAGGERATION_DEFAULT);
  });

  root.append(head, input);
  return { root, input, setValue: show };
}

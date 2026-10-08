import './debug-panel.css';

/** localStorage key holding whether the panel body is open ('1') or collapsed ('0'). */
export const DEBUG_STORAGE_KEY = 'sm-debug-open';

/**
 * @displayName Debug slider control
 * @strategicPurpose Lets a developer tune a rendering constant live without a rebuild, in a panel that is not state of record.
 * @tacticalObjective One range row: label, slider and live value. onChange fires with a number on every input event.
 */
export interface DebugControl {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly format?: (value: number) => string;
  readonly onChange: (value: number) => void;
}

/**
 * @displayName Debug toggle control
 * @strategicPurpose Lets a developer switch a rendering behaviour on or off live; not state of record.
 * @tacticalObjective One checkbox row. onChange fires with a boolean on every change event.
 */
export interface DebugToggle {
  readonly id: string;
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export interface DebugPanel {
  readonly element: HTMLElement;
  register(control: DebugControl): void;
  registerToggle(toggle: DebugToggle): void;
}

/** Builds the panel with createElement only (no HTML strings). Collapsed unless localStorage says otherwise. */
export function createDebugPanel(doc: Document): DebugPanel {
  const storage = doc.defaultView?.localStorage;
  const root = doc.createElement('div');
  root.id = 'debug-panel';
  const header = doc.createElement('button');
  header.type = 'button';
  header.textContent = 'DEBUG';
  const body = doc.createElement('div');
  body.className = 'sm-debug-body';
  const setOpen = (open: boolean): void => {
    header.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  setOpen(storage?.getItem(DEBUG_STORAGE_KEY) === '1');
  header.addEventListener('click', () => {
    const open = body.hidden;
    setOpen(open);
    storage?.setItem(DEBUG_STORAGE_KEY, open ? '1' : '0');
  });
  root.append(header, body);
  const ids = new Set<string>();
  const claim = (id: string): void => {
    if (ids.has(id)) throw new Error(`debug control ${id} is already registered`);
    ids.add(id);
  };
  return {
    element: root,
    register(control) {
      claim(control.id);
      const format = control.format ?? ((v: number) => String(v));
      const row = doc.createElement('label');
      const name = doc.createElement('span');
      name.textContent = control.label;
      const input = doc.createElement('input');
      input.type = 'range';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(control.value);
      const readout = doc.createElement('output');
      readout.textContent = format(control.value);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        readout.textContent = format(value);
        control.onChange(value);
      });
      row.append(name, input, readout);
      body.append(row);
    },
    registerToggle(toggle) {
      claim(toggle.id);
      const row = doc.createElement('label');
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.checked = toggle.value;
      const name = doc.createElement('span');
      name.textContent = toggle.label;
      input.addEventListener('change', () => toggle.onChange(input.checked));
      row.append(input, name);
      body.append(row);
    },
  };
}

let shared: DebugPanel | null = null;
function sharedPanel(): DebugPanel {
  if (shared === null) {
    shared = createDebugPanel(document);
    document.body.append(shared.element);
  }
  return shared;
}

/** Adds a slider row to the page's one DEBUG panel, mounting it on first use. */
export function registerDebugControl(control: DebugControl): void {
  sharedPanel().register(control);
}

/** Adds a checkbox row to the page's one DEBUG panel, mounting it on first use. */
export function registerDebugToggle(toggle: DebugToggle): void {
  sharedPanel().registerToggle(toggle);
}

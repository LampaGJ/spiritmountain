import { createToggleKey, iconSpan, type ClickyKey } from './clicky-key';
import { iconFor } from './icons';

/**
 * @displayName Top bar and popouts
 * @strategicPurpose Puts the camera view, the season keys and the layer switches in one centred row at the top of the page, so the left rail only carries the filter reset.
 * @tacticalObjective Finds or creates the single `nav#season-bar` with its key row, and builds popout triggers (a key plus a panel of plain buttons) of which at most one is open; outside press, Escape and the owner's close() shut it.
 */
export interface TopBar {
  readonly root: HTMLElement;
  /** The centred row of keys: the View popout, the season group and the Layers popout (CSS `order` fixes the sequence). */
  readonly keys: HTMLElement;
}

/** The season-menu.ts root id; kept so the rail offsets and the tests keep working. */
export const TOP_BAR_ID = 'season-bar';

export function getTopBar(): TopBar {
  const existing = document.getElementById(TOP_BAR_ID);
  const existingKeys = existing?.querySelector<HTMLElement>(':scope > .sm-bar-keys');
  if (existing !== null && existingKeys !== null && existingKeys !== undefined) {
    return { root: existing, keys: existingKeys };
  }
  const root = document.createElement('nav');
  root.id = TOP_BAR_ID;
  root.className = 'sm-season-bar';
  root.setAttribute('aria-label', 'Season');
  const keys = document.createElement('div');
  keys.className = 'sm-bar-keys';
  root.append(keys);
  document.body.appendChild(root);
  return { root, keys };
}

/** Removes the bar once neither a popout nor the season group is left in it. */
export function releaseTopBar(): void {
  const bar = document.getElementById(TOP_BAR_ID);
  if (bar !== null && bar.querySelector('.sm-popout, .sm-season-keys') === null) bar.remove();
}

export interface PopoutOptions {
  /** icons.json id of the trigger's glyph and label (for example `group-view`). */
  readonly iconId: string;
  /** Id of the panel; the trigger's aria-controls points at it. */
  readonly panelId: string;
  /** Accessible name of the panel group. */
  readonly panelLabel: string;
  /** `end` right-aligns the panel to its trigger (the Layers popout, at the right edge of the row). */
  readonly align?: 'start' | 'end';
}

export interface Popout {
  /** The `.sm-popout` wrapper: trigger key then panel. */
  readonly root: HTMLElement;
  readonly trigger: ClickyKey;
  /** The panel the caller fills with keys. */
  readonly panel: HTMLElement;
  open(): void;
  /** Closes the panel; with `restoreFocus`, focus returns to the trigger. */
  close(restoreFocus?: boolean): void;
  dispose(): void;
}

let openPopout: Popout | undefined;

/**
 * A key with a chevron that shows or hides a panel of buttons under it. The panel is a plain `div` group, not a menu: its
 * children are toggles and buttons. Opening one popout closes any other. An outside press or Escape closes it; Escape returns
 * focus to the trigger when focus was inside the popout.
 */
export function createPopout(options: PopoutOptions): Popout {
  const { symbol, label } = iconFor(options.iconId);
  const root = document.createElement('div');
  root.className = `sm-popout${options.align === 'end' ? ' sm-popout--end' : ''}`;
  const trigger = createToggleKey(label, { icon: symbol });
  const chevron = iconSpan(iconFor('chevron').symbol, 'ms sm-chevron');
  trigger.button.querySelector('.btn-face')?.append(chevron);
  trigger.button.setAttribute('aria-expanded', 'false');
  trigger.button.setAttribute('aria-controls', options.panelId);
  const panel = document.createElement('div');
  panel.id = options.panelId;
  panel.className = 'sm-popout-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', options.panelLabel);
  panel.hidden = true;
  root.append(trigger.root, panel);

  const isOpen = (): boolean => !panel.hidden;
  const popout: Popout = {
    root,
    trigger,
    panel,
    open() {
      if (openPopout !== undefined && openPopout !== popout) openPopout.close();
      panel.hidden = false;
      trigger.button.setAttribute('aria-expanded', 'true');
      trigger.button.setAttribute('aria-pressed', 'true');
      openPopout = popout;
    },
    close(restoreFocus = false) {
      panel.hidden = true;
      trigger.button.setAttribute('aria-expanded', 'false');
      trigger.button.setAttribute('aria-pressed', 'false');
      if (openPopout === popout) openPopout = undefined;
      if (restoreFocus) trigger.button.focus();
    },
    dispose() {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
      if (openPopout === popout) openPopout = undefined;
      root.remove();
    },
  };

  trigger.button.addEventListener('click', () => {
    if (isOpen()) popout.close();
    else popout.open();
  });
  const onOutside = (event: Event): void => {
    if (isOpen() && event.target instanceof Node && !root.contains(event.target)) popout.close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !isOpen()) return;
    popout.close(root.contains(document.activeElement));
  };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey);
  return popout;
}

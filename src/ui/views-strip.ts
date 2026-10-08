import type { ViewName } from '../scene/views';
import { createClickKey } from './clicky-key';
import { iconFor } from './icons';
import { createPopout, getTopBar, releaseTopBar } from './top-bar';

/** The camera views offered on the strip, in display order. summit-south stays reachable through the API only. */
export const STRIP_VIEWS: readonly {
  readonly name: ViewName;
  /** The id in icons.json (kebab-case, internal). */
  readonly iconId: string;
  /** The visible title-case label, from icons.json. */
  readonly label: string;
}[] = [
  { name: 'resort', iconId: 'resort', label: iconFor('resort').label },
  { name: 'overview', iconId: 'overview', label: iconFor('overview').label },
  { name: 'topdown', iconId: 'top-down', label: iconFor('top-down').label },
];

export interface ViewsDeps {
  /** SceneHandle.setView, passed as a function so this module never imports three.js. */
  readonly setView: (name: ViewName) => void;
  /** The view the scene is in when the strip mounts; marked with aria-current. */
  readonly initial?: ViewName;
  /**
   * Subscribes to "the user moved the camera by hand" (OrbitControls 'start'); returns an unsubscribe.
   * The strip then drops its aria-current mark, because no named view describes the camera any more.
   */
  readonly onUserMove?: (listener: () => void) => () => void;
}

export interface ViewsStrip {
  readonly root: HTMLElement;
  dispose(): void;
}

/**
 * @displayName Camera view strip
 * @strategicPurpose Lets a reviewer jump between the named camera views without knowing the orbit gestures.
 * @tacticalObjective Mounts a View popout at the left of the top bar whose panel holds click keys that call setView(name), close the popout and mark the active view with aria-current.
 */
export function mountViews(deps: ViewsDeps): ViewsStrip {
  const popout = createPopout({
    iconId: 'group-view',
    panelId: 'views',
    panelLabel: 'Camera view',
  });
  const root = popout.panel;

  const buttons = new Map<ViewName, HTMLButtonElement>();
  const mark = (current: ViewName | null): void => {
    for (const [name, button] of buttons) {
      if (name === current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  for (const { name, iconId, label } of STRIP_VIEWS) {
    const { root: keyRoot, button } = createClickKey(label, { icon: iconFor(iconId).symbol });
    button.dataset.view = name;
    button.addEventListener('click', () => {
      deps.setView(name);
      mark(name);
      popout.close(true);
    });
    buttons.set(name, button);
    root.append(keyRoot);
  }
  mark(deps.initial ?? null);

  const unsubscribe = deps.onUserMove?.(() => mark(null));
  getTopBar().keys.append(popout.root);

  return {
    root,
    dispose() {
      unsubscribe?.();
      popout.dispose();
      releaseTopBar();
    },
  };
}

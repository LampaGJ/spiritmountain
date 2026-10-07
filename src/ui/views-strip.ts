import './views.css';
import type { ViewName } from '../scene/views';
import { createClickKey } from './clicky-key';

/** The camera views offered on the strip, in display order. summit-south stays reachable through the API only. */
export const STRIP_VIEWS: readonly { readonly name: ViewName; readonly label: string }[] = [
  { name: 'resort', label: 'Resort' },
  { name: 'overview', label: 'Overview' },
  { name: 'topdown', label: 'Top-down' },
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
 * @tacticalObjective Mounts a bottom-left group of click keys that call setView(name) and mark the active view with aria-current.
 */
export function mountViews(deps: ViewsDeps): ViewsStrip {
  const root = document.createElement('div');
  root.id = 'views';
  root.className = 'sm-plate sm-views';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Camera view');

  const caption = document.createElement('span');
  caption.className = 'views-caption';
  caption.textContent = 'View';
  root.append(caption);

  const buttons = new Map<ViewName, HTMLButtonElement>();
  const mark = (current: ViewName | null): void => {
    for (const [name, button] of buttons) {
      if (name === current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  for (const { name, label } of STRIP_VIEWS) {
    const { root: keyRoot, button } = createClickKey(label);
    button.dataset.view = name;
    button.addEventListener('click', () => {
      deps.setView(name);
      mark(name);
    });
    buttons.set(name, button);
    root.append(keyRoot);
  }
  mark(deps.initial ?? null);

  const unsubscribe = deps.onUserMove?.(() => mark(null));
  document.body.append(root);

  return {
    root,
    dispose() {
      unsubscribe?.();
      root.remove();
    },
  };
}

import './reveal.css';
import markUrl from './spirit-mark.svg';

/** Length of the vignette opening, in ms; matches the 1.2s in reveal.css. */
export const REVEAL_MS = 1200;
/** Length of the opacity fade used in reduced-motion and `fade` modes, in ms; matches reveal.css. */
export const FADE_MS = 200;
/** Margin added to the animation length for the JS completion backstop, in ms. */
export const BACKSTOP_MARGIN_MS = 100;
/** Feather width added to the end radius, in CSS pixels. */
const FEATHER_PX = 160;
/** A late load shorter than this never re-covers the scene. */
const RECOVER_GRACE_MS = 300;
/** Frames that must run after the last settle before the scene counts as rendered. */
const FRAMES_AFTER_SETTLE = 2;

/** The JS completion backstop for the overlay: animation length plus margin, never the full 1.2 s in fade modes. */
export const backstopMs = (fade: boolean): number =>
  (fade ? FADE_MS : REVEAL_MS) + BACKSTOP_MARGIN_MS;

export type FrameSubscribe = (callback: (deltaMs: number) => void) => () => void;

export interface ReadinessOptions {
  /** Subscribes to the per-frame callback (runs before each render); returns an unsubscribe. */
  readonly onFrame: FrameSubscribe;
  /** Fires once when everything registered has settled and two frames have run; again after a re-cover when enabled. */
  readonly onReady: () => void;
  readonly timeoutMs?: number;
  readonly frameWaitCapMs?: number;
  /** Default false. When true, a late `track()` load over 300 ms re-covers the scene and reveals it again. */
  readonly recoverOnLateLoad?: boolean;
  /** Reserved; wired to nothing. View changes do not replay the reveal. */
  readonly replayOnViewChange?: boolean;
  readonly onTimeout?: (unsettled: string[]) => void;
  /** Called when a late load re-covers the scene (only with recoverOnLateLoad). */
  readonly onCover?: () => void;
  /** Called whenever the unsettled set changes, for the overlay label. */
  readonly onChange?: (unsettled: string[]) => void;
}

export interface ReadinessState {
  readonly total: number;
  readonly settled: number;
  readonly unsettled: string[];
}

export interface Readiness {
  register(name: string, promise: Promise<unknown>): void;
  seal(): void;
  state(): ReadinessState;
  track(name: string, promise: Promise<unknown>): void;
}

interface Waiting {
  frames: number;
  unsubscribe: () => void;
  cap: ReturnType<typeof setTimeout>;
}

/**
 * @displayName Scene readiness tracker
 * @strategicPurpose Keeps the black cover up until every layer the URL hash asked for has installed and rendered.
 * @tacticalObjective Counts registered promises, then waits two frames after the last settle before calling onReady once.
 */
export function createReadiness(opts: ReadinessOptions): Readiness {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const frameWaitCapMs = opts.frameWaitCapMs ?? 2000;
  const recover = opts.recoverOnLateLoad ?? false;
  const names = new Map<string, Promise<unknown>>();
  const settled = new Set<string>();
  const seen = new WeakSet<Promise<unknown>>();
  let sealed = false;
  let fired = false;
  let waiting: Waiting | null = null;

  const unsettled = (): string[] => [...names.keys()].filter((n) => !settled.has(n));
  const notify = (): void => opts.onChange?.(unsettled());

  function stopWaiting(): void {
    if (!waiting) return;
    waiting.unsubscribe();
    clearTimeout(waiting.cap);
    waiting = null;
  }

  function fire(): void {
    if (fired) return;
    fired = true;
    stopWaiting();
    opts.onReady();
  }

  function beginWaiting(): void {
    if (waiting || fired) return;
    const state: Waiting = {
      frames: 0,
      unsubscribe: () => undefined,
      cap: setTimeout(fire, frameWaitCapMs),
    };
    waiting = state;
    state.unsubscribe = opts.onFrame(() => {
      state.frames += 1;
      if (state.frames >= FRAMES_AFTER_SETTLE) fire();
    });
  }

  function check(): void {
    if (!sealed || fired) return;
    if (settled.size === names.size) beginWaiting();
  }

  function settle(name: string): void {
    if (settled.has(name)) return;
    settled.add(name);
    if (waiting) waiting.frames = 0;
    notify();
    check();
  }

  function watch(name: string, promise: Promise<unknown>): void {
    promise.then(
      () => settle(name),
      (error: unknown) => {
        console.error(`reveal: ${name} rejected`, error);
        settle(name);
      },
    );
  }

  let lateCovered = false;
  let latePending = 0;
  function lateSettled(): void {
    latePending -= 1;
    if (latePending > 0 || !lateCovered) return;
    lateCovered = false;
    fired = false;
    beginWaiting();
  }

  const readiness: Readiness = {
    register(name, promise) {
      if (sealed) return readiness.track(name, promise);
      if (seen.has(promise)) return;
      seen.add(promise);
      names.set(name, promise);
      watch(name, promise);
      notify();
    },
    track(name, promise) {
      if (seen.has(promise)) return;
      seen.add(promise);
      if (!fired) {
        names.set(name, promise);
        stopWaiting();
        watch(name, promise);
        notify();
        return;
      }
      if (!recover) return;
      let done = false;
      latePending += 1;
      const finish = (): void => {
        if (done) return;
        done = true;
        lateSettled();
      };
      promise.then(finish, finish);
      setTimeout(() => {
        if (done || lateCovered) return;
        lateCovered = true;
        opts.onCover?.();
      }, RECOVER_GRACE_MS);
    },
    seal() {
      if (sealed) return;
      sealed = true;
      setTimeout(() => {
        if (fired || waiting) return;
        const pending = unsettled();
        console.warn(`reveal: watchdog, unsettled: ${pending.join(', ')}`);
        opts.onTimeout?.(pending);
        beginWaiting();
      }, timeoutMs);
      check();
    },
    state() {
      return { total: names.size, settled: settled.size, unsettled: unsettled() };
    },
  };
  return readiness;
}

export interface RevealOverlay {
  readonly element: HTMLElement;
  setLabel(unsettled: readonly string[]): void;
  open(): void;
  dismiss(): void;
  cover(): void;
}

/**
 * @displayName Reveal overlay
 * @strategicPurpose Hides the scene assembling and shows only the finished view.
 * @tacticalObjective Adopts or builds #reveal, opens it as a centre-out vignette, and removes it when done.
 */
export function createRevealOverlay(doc: Document): RevealOverlay {
  let found = doc.getElementById('reveal');
  if (!found) {
    found = doc.createElement('div');
    found.id = 'reveal';
    found.dataset['state'] = 'covered';
    doc.body.prepend(found);
  }
  const root = found;
  let logo = doc.getElementById('reveal-logo');
  if (!logo) {
    const img = doc.createElement('img');
    img.id = 'reveal-logo';
    img.src = markUrl;
    img.alt = 'Spirit Mountain';
    img.decoding = 'async';
    root.append(img);
    logo = img;
  }
  const logoEl = logo;
  let label = doc.getElementById('reveal-label');
  if (!label) {
    label = doc.createElement('div');
    label.id = 'reveal-label';
    root.append(label);
  }
  const labelEl = label;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let opened = false;

  const finish = (): void => {
    clearTimeout(backstop);
    root.dataset['state'] = 'gone';
    root.remove();
  };
  root.addEventListener('animationend', () => {
    if (opened) finish();
  });

  const lacksRegisteredProperty = (): boolean =>
    typeof CSS === 'undefined' || !('registerProperty' in CSS);
  const reducedMotion = (): boolean =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  return {
    element: root,
    setLabel(unsettled) {
      labelEl.textContent = unsettled.length > 0 ? `loading ${unsettled.join(', ')}` : '';
    },
    open() {
      opened = true;
      root.style.pointerEvents = 'none';
      labelEl.hidden = true;
      logoEl.hidden = true;
      const end = Math.hypot(window.innerWidth, window.innerHeight) / 2 + FEATHER_PX;
      root.style.setProperty('--reveal-end', `${end}px`);
      const fade = lacksRegisteredProperty() || reducedMotion();
      requestAnimationFrame(() => {
        if (root.isConnected) root.dataset['state'] = fade ? 'fade' : 'revealing';
      });
      backstop = setTimeout(finish, backstopMs(fade));
    },
    dismiss() {
      opened = true;
      finish();
    },
    cover() {
      clearTimeout(backstop);
      opened = false;
      root.style.pointerEvents = 'auto';
      labelEl.hidden = false;
      logoEl.hidden = false;
      root.dataset['state'] = 'covering';
      if (!root.isConnected) doc.body.prepend(root);
    },
  };
}

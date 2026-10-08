// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backstopMs,
  createReadiness,
  createRevealOverlay,
  type ReadinessOptions,
} from '../../src/ui/reveal';

const css = readFileSync(resolve(__dirname, '../../src/ui/reveal.css'), 'utf8');

/** A hand-driven onFrame: tick() runs every subscribed callback once. */
function fakeFrames() {
  const callbacks = new Set<(d: number) => void>();
  return {
    onFrame: (cb: (d: number) => void) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    tick: () => [...callbacks].forEach((cb) => cb(16)),
    size: () => callbacks.size,
  };
}

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup(extra: Partial<ReadinessOptions> = {}) {
  const frames = fakeFrames();
  const onReady = vi.fn();
  const readiness = createReadiness({ onFrame: frames.onFrame, onReady, ...extra });
  return { frames, onReady, readiness };
}

describe('createReadiness', () => {
  it('fires once, after every promise settles and two frames, in any settle order', async () => {
    const { frames, onReady, readiness } = setup();
    const a = deferred();
    const b = deferred();
    const c = deferred();
    readiness.register('a', a.promise);
    readiness.register('b', b.promise);
    readiness.register('c', c.promise);
    readiness.seal();
    c.resolve();
    a.resolve();
    await flush();
    frames.tick();
    frames.tick();
    expect(onReady).not.toHaveBeenCalled();
    b.resolve();
    await flush();
    frames.tick();
    expect(onReady).not.toHaveBeenCalled();
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does not fire before seal()', async () => {
    const { frames, onReady, readiness } = setup();
    readiness.register('a', Promise.resolve());
    await flush();
    frames.tick();
    frames.tick();
    frames.tick();
    expect(onReady).not.toHaveBeenCalled();
    readiness.seal();
    frames.tick();
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('seal() with zero registrations fires after two frames', () => {
    const { frames, onReady, readiness } = setup();
    readiness.seal();
    frames.tick();
    expect(onReady).not.toHaveBeenCalled();
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('counts a rejected promise as settled and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { frames, onReady, readiness } = setup();
    const a = deferred();
    readiness.register('a', a.promise);
    readiness.seal();
    a.reject(new Error('boom'));
    await flush();
    frames.tick();
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it('seal() twice and register() after seal() never fire twice', async () => {
    const { frames, onReady, readiness } = setup();
    readiness.seal();
    readiness.seal();
    frames.tick();
    frames.tick();
    readiness.register('late', Promise.resolve());
    await flush();
    frames.tick();
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('reports the unsettled names for an imagery-off style registration set', () => {
    const { readiness } = setup();
    for (const name of [
      'terrain',
      'surface',
      'trees',
      'buildings',
      'annotations',
      'context',
      'ground-colour',
      'sky',
    ]) {
      readiness.register(
        name,
        name === 'terrain' ? Promise.resolve() : new Promise(() => undefined),
      );
    }
    expect(readiness.state().unsettled).not.toContain('imagery');
    expect(readiness.state().unsettled).toEqual(
      expect.arrayContaining([
        'surface',
        'trees',
        'buildings',
        'annotations',
        'context',
        'ground-colour',
        'sky',
      ]),
    );
    expect(readiness.state().total).toBe(8);
  });

  it('watchdog warns with the unsettled names and reveals after the frame cap with a dead onFrame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onReady = vi.fn();
    const readiness = createReadiness({ onFrame: () => () => undefined, onReady });
    readiness.register('stuck', new Promise(() => undefined));
    readiness.seal();
    vi.advanceTimersByTime(19999);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stuck'));
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('a late track() never re-covers by default', async () => {
    const onCover = vi.fn();
    const { frames, onReady, readiness } = setup({ onCover });
    readiness.seal();
    frames.tick();
    frames.tick();
    const slow = deferred();
    readiness.track('surface', slow.promise);
    vi.advanceTimersByTime(1000);
    slow.resolve();
    await flush();
    frames.tick();
    frames.tick();
    expect(onCover).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('with recoverOnLateLoad a 299 ms load does not re-cover and a 301 ms load does', async () => {
    const onCover = vi.fn();
    const { frames, onReady, readiness } = setup({ onCover, recoverOnLateLoad: true });
    readiness.seal();
    frames.tick();
    frames.tick();
    const quick = deferred();
    readiness.track('quick', quick.promise);
    vi.advanceTimersByTime(299);
    quick.resolve();
    await flush();
    vi.advanceTimersByTime(10);
    expect(onCover).not.toHaveBeenCalled();
    const slow = deferred();
    readiness.track('slow', slow.promise);
    vi.advanceTimersByTime(301);
    expect(onCover).toHaveBeenCalledTimes(1);
    slow.resolve();
    await flush();
    frames.tick();
    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('track() of an already-registered promise is a no-op', () => {
    const onCover = vi.fn();
    const { frames, readiness } = setup({ onCover, recoverOnLateLoad: true });
    const p = new Promise<void>(() => undefined);
    readiness.register('surface', p);
    readiness.track('surface', p);
    expect(readiness.state().total).toBe(1);
    readiness.seal();
    frames.tick();
    vi.advanceTimersByTime(1000);
    expect(onCover).not.toHaveBeenCalled();
  });
});

describe('createRevealOverlay', () => {
  it('adopts an existing #reveal and creates no second element', () => {
    const existing = document.createElement('div');
    existing.id = 'reveal';
    document.body.append(existing);
    const overlay = createRevealOverlay(document);
    expect(overlay.element).toBe(existing);
    expect(document.querySelectorAll('#reveal')).toHaveLength(1);
  });

  it('builds #reveal first in the body when absent', () => {
    document.body.append(document.createElement('main'));
    createRevealOverlay(document);
    expect(document.body.firstElementChild?.id).toBe('reveal');
  });

  it('dismiss() removes it at once', () => {
    const overlay = createRevealOverlay(document);
    overlay.dismiss();
    expect(document.getElementById('reveal')).toBeNull();
  });

  it('open() sets pointer-events none at once and removes the element at the backstop', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
    const overlay = createRevealOverlay(document);
    overlay.setLabel(['sky']);
    expect(overlay.element.textContent).toContain('sky');
    overlay.open();
    expect(overlay.element.style.pointerEvents).toBe('none');
    vi.advanceTimersByTime(1);
    expect(overlay.element.dataset['state']).toBe('fade');
    vi.advanceTimersByTime(backstopMs(true));
    expect(document.getElementById('reveal')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('the completion backstop is 200 ms plus margin in fade mode, not 1.3 s', () => {
    expect(backstopMs(true)).toBeLessThan(1000);
    expect(backstopMs(true)).toBeGreaterThanOrEqual(200);
    expect(backstopMs(false)).toBe(1300);
  });
});

describe('reveal.css', () => {
  it('declares the registered radius, the easing, and the reduced-motion fade', () => {
    expect(css).toContain('@property --reveal-r');
    expect(css).toContain('cubic-bezier(0, 0, 0.2, 1)');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('200ms');
    expect(css).toContain('z-index: 100');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountViews, STRIP_VIEWS, type ViewsStrip } from '../../src/ui/views-strip';

let strip: ViewsStrip | undefined;

afterEach(() => {
  strip?.dispose();
  strip = undefined;
});

const keyOf = (name: string): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(`#views button[data-view="${name}"]`);
  if (found === null) throw new Error(`no view key ${name}`);
  return found;
};

describe('views strip', () => {
  it('offers Resort, Overview and Top-down in a labelled group', () => {
    strip = mountViews({ setView: vi.fn() });
    const root = document.getElementById('views');
    expect(root?.getAttribute('role')).toBe('group');
    expect(root?.getAttribute('aria-label')).toBe('Camera view');
    const labels = [...document.querySelectorAll('#views button')].map((b) => b.textContent);
    expect(labels).toEqual(STRIP_VIEWS.map((v) => v.label));
  });

  it('calls setView with the view name and marks it aria-current', () => {
    const setView = vi.fn();
    strip = mountViews({ setView, initial: 'resort' });
    expect(keyOf('resort').getAttribute('aria-current')).toBe('true');
    keyOf('topdown').click();
    expect(setView).toHaveBeenCalledWith('topdown');
    expect(keyOf('topdown').getAttribute('aria-current')).toBe('true');
    expect(keyOf('resort').hasAttribute('aria-current')).toBe(false);
  });

  it('drops the aria-current mark when the user moves the camera by hand', () => {
    let move: () => void = () => {};
    strip = mountViews({
      setView: vi.fn(),
      initial: 'overview',
      onUserMove: (listener) => {
        move = listener;
        return () => {};
      },
    });
    move();
    expect(document.querySelector('#views [aria-current]')).toBeNull();
  });
});

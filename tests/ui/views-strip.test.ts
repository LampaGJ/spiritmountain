// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iconFor } from '../../src/ui/icons';
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
  it('offers Resort, Overview and Top Down in a labelled group', () => {
    strip = mountViews({ setView: vi.fn() });
    const root = document.getElementById('views');
    expect(root?.getAttribute('role')).toBe('group');
    expect(root?.getAttribute('aria-label')).toBe('Camera view');
    const labels = [...document.querySelectorAll('#views button .btn-label')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Resort', 'Overview', 'Top Down']);
    expect(labels).toEqual(STRIP_VIEWS.map((v) => v.label));
  });

  it('gives every key an aria-hidden icon span and keeps the label as the accessible text', () => {
    strip = mountViews({ setView: vi.fn() });
    for (const { name, iconId, label } of STRIP_VIEWS) {
      const button = keyOf(name);
      const icon = button.querySelector('.ms');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.textContent).toBe(iconFor(iconId).symbol);
      expect(button.querySelector('.btn-label')?.textContent).toBe(label);
    }
  });

  it('is a View popout at the left of the top bar, closed until the trigger is pressed', () => {
    strip = mountViews({ setView: vi.fn() });
    const root = document.getElementById('views');
    const popout = root?.parentElement;
    expect(popout?.classList.contains('sm-popout')).toBe(true);
    expect(popout?.parentElement?.classList.contains('sm-bar-keys')).toBe(true);
    expect(document.getElementById('rail')).toBeNull();
    const trigger = popout?.querySelector<HTMLButtonElement>(':scope > .cl-key button');
    expect(trigger?.querySelector('.btn-label')?.textContent).toBe('View');
    expect(trigger?.querySelector('.ms')?.textContent).toBe(iconFor('group-view').symbol);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('aria-controls')).toBe('views');
    expect(root?.hidden).toBe(true);
    trigger?.click();
    expect(root?.hidden).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes the popout and returns focus to the trigger when a view is chosen', () => {
    strip = mountViews({ setView: vi.fn() });
    const trigger = document.querySelector<HTMLButtonElement>('.sm-popout > .cl-key button');
    trigger?.click();
    keyOf('overview').click();
    expect(document.getElementById('views')?.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('removes the top bar with its last popout on dispose', () => {
    strip = mountViews({ setView: vi.fn() });
    expect(document.getElementById('season-bar')).not.toBeNull();
    strip.dispose();
    strip = undefined;
    expect(document.getElementById('season-bar')).toBeNull();
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

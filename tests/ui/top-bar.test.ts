// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createPopout, getTopBar, releaseTopBar, type Popout } from '../../src/ui/top-bar';

const popouts: Popout[] = [];

afterEach(() => {
  for (const p of popouts.splice(0)) p.dispose();
  document.body.replaceChildren();
});

const make = (iconId: string, panelId: string): Popout => {
  const popout = createPopout({ iconId, panelId, panelLabel: panelId });
  const button = document.createElement('button');
  button.textContent = `${panelId}-item`;
  popout.panel.append(button);
  getTopBar().keys.append(popout.root);
  popouts.push(popout);
  return popout;
};

describe('top bar popouts (#58)', () => {
  it('getTopBar is one nav#season-bar with one key row, however often it is called', () => {
    const a = getTopBar();
    const b = getTopBar();
    expect(a.root).toBe(b.root);
    expect(a.root.tagName).toBe('NAV');
    expect(document.querySelectorAll('#season-bar')).toHaveLength(1);
    expect(a.keys.className).toBe('sm-bar-keys');
    releaseTopBar();
    expect(document.getElementById('season-bar')).toBeNull();
  });

  it('wires aria-expanded and aria-controls on the trigger and keeps the panel a plain group, not a menu', () => {
    const p = make('group-view', 'p-view');
    const t = p.trigger.button;
    expect(t.getAttribute('aria-controls')).toBe('p-view');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(p.panel.hidden).toBe(true);
    expect(p.panel.getAttribute('role')).toBe('group');
    expect(p.root.querySelector('[role="menu"], [role="menuitem"]')).toBeNull();
    expect(t.querySelector('.sm-chevron')?.textContent).toBe('expand_more');
    t.click();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(p.panel.hidden).toBe(false);
    t.click();
    expect(p.panel.hidden).toBe(true);
  });

  it('keeps at most one popout open', () => {
    const view = make('group-view', 'p-view');
    const layers = make('group-layers', 'p-layers');
    view.trigger.button.click();
    layers.trigger.button.click();
    expect(view.panel.hidden).toBe(true);
    expect(view.trigger.button.getAttribute('aria-expanded')).toBe('false');
    expect(layers.panel.hidden).toBe(false);
  });

  it('closes on a press outside, not on a press inside', () => {
    const p = make('group-view', 'p-view');
    p.trigger.button.click();
    p.panel.querySelector('button')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(p.panel.hidden).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(p.panel.hidden).toBe(true);
  });

  it('Escape closes it and returns focus to the trigger when focus was inside', () => {
    const p = make('group-view', 'p-view');
    p.trigger.button.click();
    const item = p.panel.querySelector('button');
    item?.focus();
    expect(document.activeElement).toBe(item);
    item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(p.panel.hidden).toBe(true);
    expect(document.activeElement).toBe(p.trigger.button);
  });
});

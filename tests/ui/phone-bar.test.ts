// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountFilters } from '../../src/ui/mount-filters';
import { mountViews } from '../../src/ui/views-strip';
import { failedAnnotationsHandle, type AnnotationsHandle } from '../../src/wire-annotations';

const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
const phoneBlock = (css: string): string => css.slice(css.indexOf('@media (max-width: 719px)'));

const loaded: AnnotationsHandle = {
  ...failedAnnotationsHandle(''),
  annotations: { status: 'loaded', map: new Map() },
};

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', location.pathname + location.search);
});

describe('phone bottom bar (under 720 px)', () => {
  const mountAll = (): HTMLElement => {
    mountFilters({
      registry: new Map(),
      handle: loaded,
      setImagery: () => {},
      setBuildings: () => {},
      setSurface: () => {},
      setTrees: () => {},
      setExaggeration: () => {},
    });
    mountViews({ setView: vi.fn() });
    const rail = document.getElementById('rail');
    if (rail === null) throw new Error('no #rail');
    return rail;
  };

  it('keeps every key inside the one #rail nav that the bar CSS targets', () => {
    const rail = mountAll();
    expect(rail.tagName).toBe('NAV');
    // 11 activities + 4 seasons + Clear + 4 layers + 3 views.
    expect(rail.querySelectorAll('button.clicky-btn, button.clicky-toggle').length).toBe(23);
    expect(rail.querySelectorAll('.group-head')).toHaveLength(4);
    expect(rail.querySelector('.filter-count')).not.toBeNull();
    expect(rail.querySelector('.exag-key input[type="range"]')).not.toBeNull();
    expect(rail.querySelector('.exag-key output')).not.toBeNull();
  });

  it('declares a fixed-height, safe-area-aware, sideways-scrolling bar', () => {
    const phone = phoneBlock(read('src/ui/rail.css'));
    expect(phone).toMatch(/--sm-bar-h: calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\);/);
    expect(phone).toMatch(/#rail \{[^}]*bottom: 0;/);
    expect(phone).toMatch(/#rail \{[^}]*height: var\(--sm-bar-h\);/);
    expect(phone).toMatch(/#rail \{[^}]*flex-direction: row;/);
    expect(phone).toMatch(/#rail \{[^}]*overflow-x: auto;/);
    expect(phone).toMatch(/#rail \{[^}]*overflow-y: hidden;/);
    expect(phone).toMatch(/#rail \{[^}]*-webkit-overflow-scrolling: touch;/);
    // The status line stays visible (a chip in the row) and the slider is one inline row.
    expect(phone).not.toMatch(/filter-count[^}]*display: none/);
    expect(phone).toMatch(/\.exag-key \{[^}]*flex-direction: row;/);
  });

  it('puts the footer and the annotation sheet above the bar, and opts in to the safe area', () => {
    const html = read('index.html');
    expect(html).toMatch(/viewport-fit=cover/);
    expect(phoneBlock(html)).toMatch(
      /#attribution \{[^}]*bottom: calc\(var\(--sm-bar-h, 0px\) \+ 4px\)/,
    );
    expect(phoneBlock(read('src/ui/panel.css'))).toMatch(/bottom: var\(--sm-bar-h, 0px\);/);
  });
});

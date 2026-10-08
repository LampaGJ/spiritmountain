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
    // Clear + 4 layers + 3 views (#56: no activity keys in the rail).
    expect(rail.querySelectorAll('button.clicky-btn, button.clicky-toggle').length).toBe(8);
    expect(rail.querySelectorAll('.group-head')).toHaveLength(2);
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

describe('season bar CSS (#42)', () => {
  const css = read('src/ui/season-menu.css');

  it('is top-anchored with the safe-area inset inside the phone block, scrolling sideways', () => {
    const phone = phoneBlock(css);
    expect(phone).toMatch(/#season-bar \{[^}]*top: 0;/);
    expect(phone).toMatch(/#season-bar \{[^}]*padding: env\(safe-area-inset-top, 0px\)/);
    // A bare bottom property (not border-bottom) would pin the bar to the bottom bar's edge.
    expect(phone).not.toMatch(/#season-bar \{[^}]*\sbottom:/);
    expect(phone).toMatch(/\.sm-season-row \{[^}]*overflow-x: auto;/);
  });

  it('declares the bar heights the rail offsets by, and the rail reads them', () => {
    expect(css).toMatch(/--sm-season-h: 52px;/);
    expect(css).toMatch(/--sm-season-open-h: 100px;/);
    const rail = read('src/ui/rail.css');
    expect(rail).toMatch(/top: calc\([^;]*var\(--sm-season-h, 0px\)\);/);
    expect(rail).toMatch(
      /body:has\(#season-bar\[data-open\]\) #rail \{[^}]*var\(--sm-season-open-h, 0px\)/,
    );
  });

  it('puts every :hover inside @media (hover: hover) and pairs it with :focus-visible', () => {
    const hoverAt = [...css.matchAll(/:hover/g)].map((m) => m.index);
    expect(hoverAt.length).toBeGreaterThan(0);
    for (const at of hoverAt) {
      const before = css.slice(0, at);
      const media = before.lastIndexOf('@media (hover: hover)');
      expect(media).toBeGreaterThan(-1);
      // No closing of the media block between it and the hover: the block opened last is still open.
      const between = css.slice(media, at);
      const opens = (between.match(/\{/g) ?? []).length;
      const closes = (between.match(/\}/g) ?? []).length;
      expect(opens).toBeGreaterThan(closes);
      const rule = css.slice(at, css.indexOf('{', at));
      expect(rule).toMatch(/:focus-visible/);
    }
  });
});

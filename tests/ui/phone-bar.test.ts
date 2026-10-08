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

  it('keeps only Clear Filters in the #rail nav and every other key in the one top bar (#58)', () => {
    const rail = mountAll();
    expect(rail.tagName).toBe('NAV');
    expect(rail.querySelectorAll('button.clicky-btn, button.clicky-toggle')).toHaveLength(1);
    expect(rail.querySelectorAll('.group-head, .exag-key, .filter-count')).toHaveLength(0);
    const bar = document.getElementById('season-bar');
    if (bar === null) throw new Error('no #season-bar');
    // View + 4 seasons + Layers triggers, 3 views, 4 layers (the activity row is empty with no season).
    expect(bar.querySelectorAll('button.clicky-btn, button.clicky-toggle')).toHaveLength(
      1 + 4 + 1 + 3 + 4,
    );
    expect(bar.querySelector(':scope > .filter-count')).not.toBeNull();
    expect(bar.querySelectorAll('.sm-bar-keys > .sm-popout')).toHaveLength(2);
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
    // The status line is never hidden, and the rail disappears with no filter active (#58).
    expect(phone).not.toMatch(/filter-count[^}]*display: none/);
    expect(read('src/ui/rail.css')).toMatch(
      /#rail:has\(> #filters\[hidden\]\) \{[^}]*display: none;/,
    );
    expect(phone).toMatch(
      /:root:has\(#filters\[hidden\]\) \{[^}]*--sm-bar-h: env\(safe-area-inset-bottom, 0px\);/,
    );
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
    expect(phone).toMatch(/\.sm-bar-keys,[^{]*\.sm-season-row \{[^}]*overflow-x: auto;/);
  });

  it('opens the popouts as full-width sheets under the bar on a phone, anchored under their key on desktop', () => {
    const phone = phoneBlock(css);
    expect(phone).toMatch(/#season-bar \.sm-popout \{[^}]*position: static;/);
    expect(phone).toMatch(/\.sm-popout-panel,[^{]*\{[^}]*left: 0;[^}]*right: 0;/);
    const desktop = css.slice(0, css.indexOf('@media (max-width: 719px)'));
    expect(desktop).toMatch(/#season-bar \.sm-popout \{[^}]*position: relative;/);
    expect(desktop).toMatch(/#season-bar \.sm-popout-panel \{[^}]*top: 100%;/);
  });

  it('declares the bar heights the rail offsets by, and the rail reads them', () => {
    expect(css).toMatch(/--sm-season-h: 108px;/);
    expect(css).toMatch(/--sm-season-open-h: 156px;/);
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

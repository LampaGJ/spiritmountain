// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivitySchema, SeasonSchema } from '../../src/schema/annotation';
import iconJson from '../../src/ui/icons.json';
import { ICONS } from '../../src/ui/icons';
import { mountFilterStrip, type FilterStrip } from '../../src/ui/filters';
import { mountViews, STRIP_VIEWS, type ViewsStrip } from '../../src/ui/views-strip';

const disposables: { dispose(): void }[] = [];

afterEach(() => {
  for (const d of disposables.splice(0)) d.dispose();
  document.body.replaceChildren();
});

describe('icon map', () => {
  it('has an entry for every activity, season, layer, view, clear, close and group header', () => {
    const ids = [
      ...ActivitySchema.options,
      ...SeasonSchema.options,
      'imagery',
      'buildings',
      'surface',
      'terrain-exaggeration',
      ...STRIP_VIEWS.map((v) => v.iconId),
      'clear-filters',
      'close-panel',
      'group-activity',
      'group-season',
      'group-layers',
      'group-view',
    ];
    for (const id of ids) expect(Object.keys(iconJson), id).toContain(id);
    expect(Object.keys(ICONS)).toEqual(Object.keys(iconJson));
  });

  it('never reuses one glyph for two controls', () => {
    const symbols = Object.values(ICONS).map((e) => e.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});

describe('every key carries an icon from icons.json', () => {
  it('has an aria-hidden icon span whose text is a name in icons.json, beside a title-case label from icons.json', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const strip: FilterStrip = mountFilterStrip({
      host,
      apply: () => ({ visibleCount: 1, total: 1 }),
      setImagery: () => {},
      setBuildings: () => {},
      readHash: () => '',
      writeHash: () => {},
    });
    const views: ViewsStrip = mountViews({ setView: vi.fn() });
    disposables.push(strip, views);
    const symbols = new Set(Object.values(iconJson).map((e) => e.symbol));
    const labels = new Set(Object.values(iconJson).map((e) => e.label));
    const keys = [...document.querySelectorAll<HTMLButtonElement>('button')];
    // 11 activities + 4 seasons + Imagery + Buildings + Clear Filters + 3 views.
    expect(keys).toHaveLength(11 + 4 + 2 + 1 + 3);
    for (const key of keys) {
      const label = key.querySelector('.btn-label')?.textContent ?? '';
      const icon = key.querySelector('.ms');
      expect(icon, label).not.toBeNull();
      expect(icon?.getAttribute('aria-hidden'), label).toBe('true');
      expect(symbols.has(icon?.textContent ?? ''), label).toBe(true);
      expect(labels.has(label), label).toBe(true);
      expect(label).not.toMatch(/-/);
      expect(label).toBe(label.replace(/\b([a-z])/g, (c) => c.toUpperCase()));
    }
  });
});

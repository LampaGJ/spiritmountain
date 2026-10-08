// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebugPanel, DEBUG_STORAGE_KEY } from '../../src/ui/debug-panel';

const control = (onChange: (v: number) => void) => ({
  id: 'width',
  label: 'Line width (px)',
  min: 1,
  max: 12,
  step: 0.5,
  value: 4,
  onChange,
});

describe('debug panel', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  it('is collapsed by default, with a DEBUG header', () => {
    const panel = createDebugPanel(document);
    expect(panel.element.querySelector('button')?.textContent).toBe('DEBUG');
    expect(panel.element.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect((panel.element.querySelector('.sm-debug-body') as HTMLElement).hidden).toBe(true);
  });

  it('renders one labelled range row per control, showing the live value', () => {
    const panel = createDebugPanel(document);
    panel.register(control(() => {}));
    const rows = panel.element.querySelectorAll('label');
    expect(rows).toHaveLength(1);
    const input = rows[0]?.querySelector('input') as HTMLInputElement;
    expect([input.type, input.min, input.max, input.step, input.value]).toEqual([
      'range',
      '1',
      '12',
      '0.5',
      '4',
    ]);
    expect(rows[0]?.textContent).toContain('Line width (px)');
    expect(rows[0]?.querySelector('output')?.textContent).toBe('4');
  });

  it('fires onChange with a number and updates the readout, honouring format', () => {
    const onChange = vi.fn();
    const panel = createDebugPanel(document);
    panel.register({ ...control(onChange), format: (v) => `${v.toFixed(1)} px` });
    const input = panel.element.querySelector('input') as HTMLInputElement;
    input.value = '6.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(6.5);
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('number');
    expect(panel.element.querySelector('output')?.textContent).toBe('6.5 px');
  });

  it('renders a checkbox toggle that fires onChange with a boolean', () => {
    const onChange = vi.fn();
    const panel = createDebugPanel(document);
    panel.registerToggle({ id: 'smooth', label: 'Smooth trails', value: true, onChange });
    const input = panel.element.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(input.checked).toBe(true);
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('toggles from the header and remembers the state in localStorage', () => {
    const panel = createDebugPanel(document);
    const header = panel.element.querySelector('button') as HTMLButtonElement;
    header.click();
    expect((panel.element.querySelector('.sm-debug-body') as HTMLElement).hidden).toBe(false);
    expect(localStorage.getItem(DEBUG_STORAGE_KEY)).toBe('1');
    expect(DEBUG_STORAGE_KEY).toBe('sm-debug-open');
    const again = createDebugPanel(document);
    expect(again.element.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('rejects a duplicate control id', () => {
    const panel = createDebugPanel(document);
    panel.register(control(() => {}));
    expect(() => panel.register(control(() => {}))).toThrow(/width/);
  });
});

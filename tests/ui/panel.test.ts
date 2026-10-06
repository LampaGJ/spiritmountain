// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createPanel, type AnnotationPanel } from '../../src/ui/panel';
import { createTooltip } from '../../src/ui/tooltip';
import type { PanelModel } from '../../src/ui/panel-model';

const SCRIPT = '<script>window.pwned = 1</script>';
const IMG = '<img src=x onerror=alert(1)>';

let root: HTMLElement;
let onClose: Mock<() => void>;
let panel: AnnotationPanel;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('aside');
  document.body.append(root);
  onClose = vi.fn<() => void>();
  panel = createPanel(root, onClose);
});
afterEach(() => panel.dispose());

const annotated = (
  over: Partial<Extract<PanelModel, { state: 'annotated' }>> = {},
): PanelModel => ({
  state: 'annotated',
  areaId: 'way/1',
  title: 'Boulder',
  kind: 'downhill-run',
  difficulty: null,
  activities: [{ activity: 'alpine-ski', seasons: [], notes: '' }],
  stakeholders: [],
  notes: '',
  ...over,
});

describe('panel rendering (textContent only)', () => {
  it('renders script and img markup as literal text, creating no elements', () => {
    panel.show(
      annotated({
        title: SCRIPT,
        notes: IMG,
        activities: [{ activity: 'alpine-ski', seasons: ['winter'], notes: SCRIPT }],
      }),
    );
    expect(root.querySelector('script, img')).toBeNull();
    expect(root.textContent).toContain('<script>');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows the exact no-annotation text, name, kind and id, and no empty rows', () => {
    panel.show({
      state: 'no-annotation',
      areaId: 'way/9',
      title: 'Nine',
      kind: 'snow-park',
      difficulty: null,
    });
    expect(root.textContent).toContain('No annotation for this area');
    expect(root.textContent).toContain('Nine');
    expect(root.textContent).toContain('snow-park');
    expect(root.textContent).toContain('way/9');
    expect(root.querySelector('.panel-list')).toBeNull();
    for (const row of root.querySelectorAll('.panel-row')) {
      expect(row.textContent?.trim()).not.toBe('');
    }
  });

  it('renders an empty seasons array as "not recorded"', () => {
    panel.show(annotated());
    expect(root.querySelector('.panel-list')?.textContent).toContain('not recorded');
  });

  it('renders the failed state as a red alert and never as no-annotation', () => {
    panel.show({
      state: 'failed',
      areaId: 'way/1',
      title: 'Boulder',
      kind: 'downhill-run',
      difficulty: null,
      errorMessage: 'annotations.json failed schema parse at annotations.0',
    });
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Annotations failed to load');
    expect(root.classList.contains('panel-failed')).toBe(true);
    expect(root.textContent).not.toContain('No annotation for this area');
  });

  it('showError opens the panel with the error message', () => {
    panel.showError('HTTP 404');
    expect(panel.isOpen()).toBe(true);
    expect(root.textContent).toContain('HTTP 404');
  });
});

describe('panel closing', () => {
  it('Escape closes, calls onClose once and preventDefault', () => {
    panel.show(annotated());
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.dispatchEvent(event);
    expect(panel.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Escape does nothing while closed or while typing in an input', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    panel.show(annotated());
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.isOpen()).toBe(true);
  });

  it('the close button closes and calls onClose', () => {
    panel.show(annotated());
    root.querySelector<HTMLButtonElement>('.panel-close')?.click();
    expect(panel.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dispose removes the Escape listener', () => {
    panel.show(annotated());
    panel.dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.isOpen()).toBe(true);
  });
});

describe('tooltip (textContent only)', () => {
  it('shows area text literally and hides again', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const tooltip = createTooltip(element);
    tooltip.show(SCRIPT, 10, 20);
    expect(element.querySelector('script, img')).toBeNull();
    expect(element.textContent).toBe(SCRIPT);
    expect(element.hidden).toBe(false);
    tooltip.hide();
    expect(element.hidden).toBe(true);
  });
});

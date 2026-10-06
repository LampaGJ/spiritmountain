import { NOT_RECORDED, type PanelModel } from './panel-model';

/**
 * @displayName Annotation panel
 * @strategicPurpose The read-only stakeholder-review surface: shows one area's annotation beside the scene.
 * @tacticalObjective Renders a PanelModel with createElement and textContent only, closes on the close button or Escape, and reports closing to the caller.
 */
export interface AnnotationPanel {
  show(model: PanelModel): void;
  showError(message: string): void;
  setFooter(text: string): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

const NO_ANNOTATION_TEXT = 'No annotation for this area';

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Builds the panel inside `root` (the aside from index.html). `onClose` runs after every close,
 * including Escape, so the caller can clear the selection highlight and return focus to the canvas.
 */
export function createPanel(root: HTMLElement, onClose: () => void): AnnotationPanel {
  const doc = root.ownerDocument;
  const heading = el(doc, 'h2', '', 'panel-title');
  heading.id = 'annotation-panel-title';
  const closeButton = el(doc, 'button', 'Close', 'panel-close');
  closeButton.type = 'button';
  const header = el(doc, 'header', undefined, 'panel-header');
  header.append(heading, closeButton);
  const body = el(doc, 'div', undefined, 'panel-body');
  const footer = el(doc, 'footer', '', 'panel-footer');
  root.append(header, body, footer);
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-labelledby', heading.id);
  root.hidden = true;

  function open(): void {
    root.hidden = false;
  }

  function close(): void {
    if (root.hidden) return;
    root.hidden = true;
    onClose();
  }

  function row(label: string, value: string | null): HTMLElement {
    const line = el(doc, 'p', undefined, 'panel-row');
    const name = el(doc, 'span', `${label}: `, 'panel-label');
    const text = value === null || value === '' ? NOT_RECORDED : value;
    const content = el(
      doc,
      'span',
      text,
      value === null || value === '' ? 'panel-blank' : 'panel-value',
    );
    line.append(name, content);
    return line;
  }

  function renderCommon(model: PanelModel): void {
    heading.textContent = model.title;
    body.replaceChildren();
    body.append(
      el(doc, 'p', model.areaId, 'panel-id'),
      row('Kind', model.kind),
      row('Difficulty', model.difficulty),
    );
  }

  function show(model: PanelModel): void {
    renderCommon(model);
    root.classList.toggle('panel-failed', model.state === 'failed');
    if (model.state === 'failed') {
      const alert = el(
        doc,
        'p',
        `Annotations failed to load: ${model.errorMessage}`,
        'panel-error',
      );
      alert.setAttribute('role', 'alert');
      body.append(alert);
    } else if (model.state === 'no-annotation') {
      body.append(el(doc, 'p', NO_ANNOTATION_TEXT, 'panel-empty'));
    } else {
      body.append(el(doc, 'h3', 'Activities'));
      if (model.activities.length === 0) {
        body.append(el(doc, 'p', NOT_RECORDED, 'panel-blank'));
      } else {
        const list = el(doc, 'ul', undefined, 'panel-list');
        for (const entry of model.activities) {
          const item = el(doc, 'li');
          item.append(
            row(entry.activity, entry.seasons.length === 0 ? null : entry.seasons.join(', ')),
          );
          if (entry.notes !== '') item.append(el(doc, 'p', entry.notes, 'panel-note'));
          list.append(item);
        }
        body.append(list);
      }
      body.append(el(doc, 'h3', 'Stakeholders'));
      if (model.stakeholders.length === 0) {
        body.append(el(doc, 'p', NOT_RECORDED, 'panel-blank'));
      } else {
        const list = el(doc, 'ul', undefined, 'panel-list');
        for (const stakeholder of model.stakeholders) {
          const item = el(doc, 'li');
          item.append(row(stakeholder.orgName, stakeholder.role));
          list.append(item);
        }
        body.append(list);
      }
      body.append(
        el(doc, 'h3', 'Notes'),
        model.notes === ''
          ? el(doc, 'p', NOT_RECORDED, 'panel-blank')
          : el(doc, 'p', model.notes, 'panel-value'),
      );
    }
    open();
  }

  function showError(message: string): void {
    heading.textContent = 'Annotations unavailable';
    body.replaceChildren();
    root.classList.add('panel-failed');
    const alert = el(doc, 'p', `Annotations failed to load: ${message}`, 'panel-error');
    alert.setAttribute('role', 'alert');
    body.append(alert);
    open();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || root.hidden || isTypingTarget(event.target)) return;
    event.preventDefault();
    close();
  }

  closeButton.addEventListener('click', close);
  doc.addEventListener('keydown', onKeydown);

  return {
    show,
    showError,
    setFooter(text) {
      footer.textContent = text;
    },
    close,
    isOpen: () => !root.hidden,
    dispose() {
      doc.removeEventListener('keydown', onKeydown);
      closeButton.removeEventListener('click', close);
    },
  };
}

// @vitest-environment jsdom
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AreaEntry } from '../src/scene/areas';
import { AreaSchema } from '../src/schema/area';
import {
  failedAnnotationsHandle,
  wireAnnotations,
  type AnnotationsHandle,
} from '../src/wire-annotations';

const annotationsFile = {
  version: 1,
  generatedFrom: { inputHash: 'a'.repeat(64), codeCommit: 'b'.repeat(40), effect: 'expands' },
  organizations: [
    {
      id: 'org-a',
      name: 'Org A',
      url: null,
      type: 'club',
      activities: [],
      sourceUrl: '',
      verified: false,
    },
  ],
  annotations: [{ areaId: 'way/1', activities: [], stakeholders: [], notes: '' }],
};
const respond = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

function entryFor(id: string, material: LineMaterial) {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 1, 0, 0]);
  const line = new Line2(geometry, material);
  line.userData['areaId'] = id;
  const area = AreaSchema.parse({
    id,
    kind: 'downhill-run',
    name: id,
    difficulty: null,
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0, 0],
        [1, 1, 0],
      ],
    },
    osmTags: {},
  });
  const entry: AreaEntry = { area, lines: [line] };
  return { entry, line };
}

let handle: AnnotationsHandle | undefined;
beforeEach(() => document.body.replaceChildren());
afterEach(() => handle?.dispose());

async function setup(fetchFn: typeof fetch) {
  const shared = new LineMaterial({ color: 0xd55e00, linewidth: 3 });
  const one = entryFor('way/1', shared);
  const two = entryFor('way/2', shared);
  const registry = new Map<string, AreaEntry>([
    ['way/1', one.entry],
    ['way/2', two.entry],
  ]);
  const panelRoot = document.createElement('aside');
  const tooltipRoot = document.createElement('div');
  const canvas = document.createElement('canvas');
  document.body.append(panelRoot, tooltipRoot, canvas);
  const controls = { addEventListener() {}, removeEventListener() {} } as unknown as OrbitControls;
  handle = await wireAnnotations({
    scene: {
      camera: {} as PerspectiveCamera,
      renderer: { domElement: canvas } as unknown as WebGLRenderer,
      controls,
      onFrame() {},
    },
    registry,
    annotationsUrl: '/annotations.json',
    panelRoot,
    tooltipRoot,
    fetchFn,
  });
  return { handle, shared, lineOne: one.line, lineTwo: two.line, panelRoot };
}

describe('wireAnnotations handle', () => {
  it('reports status loaded with the annotation map', async () => {
    const { handle: h } = await setup(respond(annotationsFile));
    expect(h.annotations.status).toBe('loaded');
    if (h.annotations.status === 'loaded') expect(h.annotations.map.size).toBe(1);
  });

  it('onFilterApplied hiding the selection closes the panel, clears the selection and restores the material', async () => {
    const { handle: h, shared, lineOne, panelRoot } = await setup(respond(annotationsFile));
    h.select('way/1');
    expect(h.getSelectedAreaId()).toBe('way/1');
    expect(panelRoot.hidden).toBe(false);
    expect(lineOne.material).not.toBe(shared);
    h.onFilterApplied(new Set(['way/2']));
    expect(h.getSelectedAreaId()).toBeNull();
    expect(panelRoot.hidden).toBe(true);
    expect(lineOne.material).toBe(shared);
  });

  it('onFilterApplied leaves the panel open when the selection stays visible', async () => {
    const { handle: h, panelRoot } = await setup(respond(annotationsFile));
    h.select('way/1');
    h.onFilterApplied(new Set(['way/1', 'way/2']));
    expect(h.getSelectedAreaId()).toBe('way/1');
    expect(panelRoot.hidden).toBe(false);
  });

  it('clearHover keeps the selection highlighted', async () => {
    const { handle: h, shared, lineOne } = await setup(respond(annotationsFile));
    h.select('way/1');
    h.clearHover();
    expect(h.getSelectedAreaId()).toBe('way/1');
    expect(lineOne.material).not.toBe(shared);
  });

  it('a failed load reports status failed, shows the red alert, and select still works', async () => {
    const { handle: h, panelRoot } = await setup(respond({}, 404));
    expect(h.annotations.status).toBe('failed');
    expect(panelRoot.querySelector('[role="alert"]')?.textContent).toContain('HTTP 404');
    h.select('way/1');
    expect(h.getSelectedAreaId()).toBe('way/1');
    expect(panelRoot.textContent).toContain('Annotations failed to load');
  });

  it('failedAnnotationsHandle reports failed and its controls are safe no-ops', () => {
    const failed = failedAnnotationsHandle('boom');
    expect(failed.annotations).toEqual({ status: 'failed', message: 'boom' });
    failed.select('way/1');
    failed.clearHover();
    failed.onFilterApplied(new Set());
    expect(failed.getSelectedAreaId()).toBeNull();
  });
});

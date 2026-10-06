import { describe, expect, it } from 'vitest';
import { AreaSchema } from '../../src/schema/area';
import { AnnotationSchema } from '../../src/schema/annotation';
import { OrganizationSchema } from '../../src/schema/organization';
import { areaTitle, buildPanelModel, type AnnotationSource } from '../../src/ui/panel-model';

const area = AreaSchema.parse({
  id: 'way/1',
  kind: 'downhill-run',
  name: 'Boulder',
  difficulty: 'intermediate',
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0, 0],
      [1, 1, 0],
    ],
  },
  osmTags: {},
});
const unnamed = AreaSchema.parse({ ...area, id: 'way/2', name: null, difficulty: null });
const org = OrganizationSchema.parse({
  id: 'org-a',
  name: 'Org A',
  url: null,
  type: 'club',
  activities: [],
  sourceUrl: '',
  verified: false,
});

function annotation(overrides: Record<string, unknown> = {}) {
  return AnnotationSchema.parse({
    areaId: 'way/1',
    activities: [
      { activity: 'alpine-ski', seasons: ['winter'], notes: '' },
      { activity: 'snowboard', seasons: [], notes: 'groomed' },
    ],
    stakeholders: [{ orgId: 'org-a', role: 'maintains' }],
    notes: '',
    ...overrides,
  });
}

function loaded(annotations: ReturnType<typeof annotation>[]): AnnotationSource {
  return {
    status: 'loaded',
    annotations: new Map(annotations.map((a) => [a.areaId, a])),
    organizations: new Map([[org.id, org]]),
  };
}

describe('buildPanelModel', () => {
  it('(1) annotated area with two activities and one stakeholder', () => {
    const model = buildPanelModel(area, loaded([annotation()]));
    if (model.state !== 'annotated') throw new Error('expected annotated');
    expect(model.title).toBe('Boulder');
    expect(model.activities).toHaveLength(2);
    expect(model.stakeholders).toEqual([{ orgName: 'Org A', role: 'maintains' }]);
  });

  it('(2) missing annotation gives state no-annotation', () => {
    expect(buildPanelModel(area, loaded([])).state).toBe('no-annotation');
  });

  it('(3) null name falls back to id plus kind; null difficulty stays null', () => {
    expect(areaTitle(unnamed)).toBe('way/2 (downhill-run)');
    const model = buildPanelModel(unnamed, loaded([]));
    expect(model.title).toBe('way/2 (downhill-run)');
    expect(model.difficulty).toBeNull();
  });

  it('(4) angle brackets stay plain text in the view model', () => {
    const evil = '<script>alert(1)</script>';
    const model = buildPanelModel({ ...area, name: evil }, loaded([annotation({ notes: evil })]));
    if (model.state !== 'annotated') throw new Error('expected annotated');
    expect(model.title).toBe(evil);
    expect(model.notes).toBe(evil);
  });

  it('(5) failed source gives state failed with the message, never no-annotation', () => {
    const model = buildPanelModel(area, { status: 'failed', message: 'boom' });
    expect(model.state).toBe('failed');
    if (model.state === 'failed') expect(model.errorMessage).toBe('boom');
  });
});

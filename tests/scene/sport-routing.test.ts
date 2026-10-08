import { describe, expect, it } from 'vitest';
import { AreaKindSchema, type Area, type AreaKind } from '../../src/schema/area';
import type { Annotation } from '../../src/schema/annotation';
import { KIND_DEFAULT_ACTIVITY, sportForArea, type Activity } from '../../src/scene/sport-routing';

const area = (kind: AreaKind): Pick<Area, 'kind'> => ({ kind });
const note = (areaId: string, ...activities: Activity[]): Annotation => ({
  areaId,
  activities: activities.map((activity) => ({ activity, seasons: [], notes: '' })),
  stakeholders: [],
  notes: '',
});
const none = new Set<Activity>();

describe('KIND_DEFAULT_ACTIVITY', () => {
  it('is total over the area kinds', () => {
    expect(new Set(Object.keys(KIND_DEFAULT_ACTIVITY))).toEqual(new Set(AreaKindSchema.options));
  });
});

describe('sportForArea', () => {
  const run = area('downhill-run');

  it('with nothing selected picks the first annotated activity', () => {
    expect(sportForArea(run, note('way/1', 'snowboard', 'alpine-ski'), none)).toBe('snowboard');
    expect(sportForArea(run, note('way/1', 'alpine-ski', 'snowboard'), none)).toBe('alpine-ski');
  });

  it('picks the selected activity when the area carries it', () => {
    const annotation = note('way/1', 'alpine-ski', 'snowboard');
    expect(sportForArea(run, annotation, new Set<Activity>(['snowboard']))).toBe('snowboard');
    expect(sportForArea(run, annotation, new Set<Activity>(['alpine-ski']))).toBe('alpine-ski');
  });

  it('with two selected activities both carried picks the first annotated one that is selected', () => {
    const annotation = note('way/1', 'hike', 'alpine-ski', 'snowboard');
    expect(sportForArea(run, annotation, new Set<Activity>(['snowboard', 'alpine-ski']))).toBe(
      'alpine-ski',
    );
    expect(sportForArea(run, annotation, new Set<Activity>(['snowboard', 'tubing']))).toBe(
      'snowboard',
    );
  });

  it('falls back to the first annotated activity when no selected one is carried', () => {
    const trail = area('nordic-trail');
    expect(
      sportForArea(trail, note('way/2', 'nordic-classic'), new Set<Activity>(['nordic-skate'])),
    ).toBe('nordic-classic');
  });

  it('lift-ride routes to lift-ride', () => {
    expect(sportForArea(run, note('way/1', 'lift-ride', 'snowboard'), none)).toBe('lift-ride');
  });

  it('an unannotated area, or one with no activities, picks the kind default', () => {
    expect(sportForArea(area('nordic-trail'), undefined, none)).toBe('nordic-classic');
    expect(sportForArea(area('mtb-route'), note('b'), none)).toBe('mountain-bike');
    expect(sportForArea(area('snow-park'), undefined, none)).toBe('alpine-ski');
    expect(sportForArea(area('hiking-trail'), undefined, none)).toBe('hike');
  });

  it('a lift defaults to lift-ride', () => {
    expect(KIND_DEFAULT_ACTIVITY.lift).toBe('lift-ride');
    expect(sportForArea(area('lift'), undefined, none)).toBe('lift-ride');
    expect(sportForArea(area('lift'), note('l', 'lift-ride'), none)).toBe('lift-ride');
  });
});

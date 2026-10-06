import { describe, expect, it } from 'vitest';
import {
  ActivitySchema,
  AnnotationSchema,
  SeasonSchema,
  StakeholderRoleSchema,
} from '../../src/schema/annotation';
import { renameKey, validAnnotation, withExtraKey } from './fixtures';

describe('AnnotationSchema', () => {
  it('parses a valid annotation with empty seasons and empty notes', () => {
    expect(AnnotationSchema.safeParse(validAnnotation).success).toBe(true);
  });
  it('rejects a renamed field', () => {
    expect(AnnotationSchema.safeParse(renameKey(validAnnotation, 'areaId', 'area')).success).toBe(
      false,
    );
  });
  it('rejects an extra unknown key', () => {
    expect(AnnotationSchema.safeParse(withExtraKey(validAnnotation)).success).toBe(false);
  });
  it('rejects a malformed areaId', () => {
    expect(AnnotationSchema.safeParse({ ...validAnnotation, areaId: 'not-an-id' }).success).toBe(
      false,
    );
  });
  it('accepts exactly the twelve activities', () => {
    expect(ActivitySchema.options).toEqual([
      'alpine-ski',
      'snowboard',
      'nordic-classic',
      'nordic-skate',
      'snowshoe',
      'fat-bike',
      'mountain-bike',
      'hike',
      'trail-run',
      'tubing',
      'lift-ride',
      'adaptive',
    ]);
  });
  it('accepts exactly the four seasons and five roles', () => {
    expect(SeasonSchema.options).toEqual(['winter', 'spring', 'summer', 'fall']);
    expect(StakeholderRoleSchema.options).toEqual([
      'maintains',
      'operates',
      'programs',
      'funds',
      'advocates',
    ]);
  });
});

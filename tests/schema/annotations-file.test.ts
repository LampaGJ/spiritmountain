import { describe, expect, it } from 'vitest';
import { AnnotationsFileSchema, annotationsFileForAreas } from '../../src/schema/annotations-file';
import { GeneratedFromSchema, ReplayRecordSchema } from '../../src/schema/replay';
import {
  renameKey,
  validAnnotation,
  validAnnotationsFile,
  validGeneratedFrom,
  validOrganization,
  validReplay,
  withExtraKey,
} from './fixtures';

describe('AnnotationsFileSchema', () => {
  it('parses a valid file', () => {
    expect(AnnotationsFileSchema.safeParse(validAnnotationsFile).success).toBe(true);
  });
  it('rejects a renamed field', () => {
    expect(
      AnnotationsFileSchema.safeParse(renameKey(validAnnotationsFile, 'generatedFrom', 'generated'))
        .success,
    ).toBe(false);
  });
  it('rejects an extra unknown key', () => {
    expect(AnnotationsFileSchema.safeParse(withExtraKey(validAnnotationsFile)).success).toBe(false);
  });
  it('rejects a generatedFrom that carries outputHash', () => {
    expect(
      AnnotationsFileSchema.safeParse({ ...validAnnotationsFile, generatedFrom: validReplay })
        .success,
    ).toBe(false);
  });
  it('rejects a wrong version', () => {
    expect(AnnotationsFileSchema.safeParse({ ...validAnnotationsFile, version: 2 }).success).toBe(
      false,
    );
  });
  it('rejects duplicate organization ids', () => {
    const file = { ...validAnnotationsFile, organizations: [validOrganization, validOrganization] };
    expect(AnnotationsFileSchema.safeParse(file).success).toBe(false);
  });
  it('rejects duplicate areaId values', () => {
    const file = { ...validAnnotationsFile, annotations: [validAnnotation, validAnnotation] };
    expect(AnnotationsFileSchema.safeParse(file).success).toBe(false);
  });
  it('rejects a stakeholder orgId that matches no organization', () => {
    const dangling = { ...validAnnotation, stakeholders: [{ orgId: 'nope', role: 'funds' }] };
    expect(
      AnnotationsFileSchema.safeParse({ ...validAnnotationsFile, annotations: [dangling] }).success,
    ).toBe(false);
  });
  it('rejects empty organizations and empty annotations', () => {
    expect(
      AnnotationsFileSchema.safeParse({ ...validAnnotationsFile, organizations: [] }).success,
    ).toBe(false);
    expect(
      AnnotationsFileSchema.safeParse({ ...validAnnotationsFile, annotations: [] }).success,
    ).toBe(false);
  });
});

describe('annotationsFileForAreas', () => {
  it('accepts a file whose areaIds all exist', () => {
    expect(
      annotationsFileForAreas(new Set(['way/123'])).safeParse(validAnnotationsFile).success,
    ).toBe(true);
  });
  it('rejects a file with an areaId missing from the set', () => {
    expect(
      annotationsFileForAreas(new Set(['way/999'])).safeParse(validAnnotationsFile).success,
    ).toBe(false);
  });
  it('still applies the base checks', () => {
    const file = { ...validAnnotationsFile, organizations: [validOrganization, validOrganization] };
    expect(annotationsFileForAreas(new Set(['way/123'])).safeParse(file).success).toBe(false);
  });
});

describe('GeneratedFromSchema', () => {
  it('accepts a record without outputHash', () => {
    expect(GeneratedFromSchema.safeParse(validGeneratedFrom).success).toBe(true);
  });
  it('rejects a record that carries outputHash', () => {
    expect(GeneratedFromSchema.safeParse(validReplay).success).toBe(false);
  });
});

describe('ReplayRecordSchema', () => {
  it('parses a valid record', () => {
    expect(ReplayRecordSchema.safeParse(validReplay).success).toBe(true);
  });
  it('rejects a renamed field', () => {
    expect(ReplayRecordSchema.safeParse(renameKey(validReplay, 'inputHash', 'input')).success).toBe(
      false,
    );
  });
  it('rejects uppercase hex, wrong lengths and a bad effect', () => {
    expect(
      ReplayRecordSchema.safeParse({ ...validReplay, inputHash: 'A'.repeat(64) }).success,
    ).toBe(false);
    expect(
      ReplayRecordSchema.safeParse({ ...validReplay, codeCommit: 'B'.repeat(40) }).success,
    ).toBe(false);
    expect(
      ReplayRecordSchema.safeParse({ ...validReplay, codeCommit: 'b'.repeat(64) }).success,
    ).toBe(false);
    expect(
      ReplayRecordSchema.safeParse({ ...validReplay, outputHash: 'c'.repeat(40) }).success,
    ).toBe(false);
    expect(ReplayRecordSchema.safeParse({ ...validReplay, effect: 'changes' }).success).toBe(false);
  });
  it('can be extended by a transform with extra members', () => {
    const Extended = ReplayRecordSchema.extend({
      dropped: ReplayRecordSchema.shape.effect.array(),
    });
    expect(Extended.safeParse({ ...validReplay, dropped: [] }).success).toBe(true);
    expect(ReplayRecordSchema.safeParse({ ...validReplay, dropped: [] }).success).toBe(false);
  });
});

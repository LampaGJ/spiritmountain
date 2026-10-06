import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrganizationSchema, OrganizationTypeSchema } from '../../src/schema/organization';
import { renameKey, validOrganization, withExtraKey } from './fixtures';

describe('OrganizationSchema', () => {
  it('parses a valid organization with null url and blank sourceUrl', () => {
    expect(OrganizationSchema.safeParse(validOrganization).success).toBe(true);
  });
  it('rejects a renamed field', () => {
    expect(OrganizationSchema.safeParse(renameKey(validOrganization, 'type', 'kind')).success).toBe(
      false,
    );
  });
  it('rejects an extra unknown key', () => {
    expect(OrganizationSchema.safeParse(withExtraKey(validOrganization)).success).toBe(false);
  });
  it('accepts exactly the six types', () => {
    expect(OrganizationTypeSchema.options).toEqual([
      'nonprofit',
      'authority',
      'municipal',
      'club',
      'business',
      'state-agency',
    ]);
  });
  it('rejects non-http urls', () => {
    expect(
      OrganizationSchema.safeParse({ ...validOrganization, url: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      OrganizationSchema.safeParse({ ...validOrganization, url: 'https://example.org' }).success,
    ).toBe(true);
  });
});

describe('real seed file scripts/ingest/organizations.seed.json', () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../../scripts/ingest/organizations.seed.json', import.meta.url), 'utf8'),
  );

  it('parses as-is: a non-empty array where every row passes OrganizationSchema', () => {
    expect(Array.isArray(raw)).toBe(true);
    const rows = raw as unknown[];
    expect(rows.length).toBeGreaterThan(0);
    const failures = rows.flatMap((row, index) => {
      const result = OrganizationSchema.safeParse(row);
      return result.success ? [] : [`row ${index}: ${result.error.message}`];
    });
    expect(failures).toEqual([]);
  });

  it('is a working instrument: the same rows with one renamed field all fail', () => {
    const rows = raw as Record<string, unknown>[];
    expect(
      rows.every(
        (row) => !OrganizationSchema.safeParse(renameKey(row, 'verified', 'isVerified')).success,
      ),
    ).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAnnotations } from '../../src/data/load-annotations';
import { buildAnnotationsFixture, readAreasFixture, type FixtureArea } from '../../scripts/fixtures/annotations-fixture';

const AREAS: FixtureArea[] = [
  { id: 'way/6', kind: 'mtb-route' },
  { id: 'way/1', kind: 'downhill-run' },
  { id: 'way/2', kind: 'nordic-trail' },
  { id: 'way/3', kind: 'mtb-trail' },
  { id: 'way/4', kind: 'lift' },
  { id: 'way/5', kind: 'snow-park' },
];
const HASH = 'c'.repeat(64);

describe('annotations fixture generator', () => {
  it('is byte-identical across two runs and independent of input order', () => {
    const a = buildAnnotationsFixture(AREAS, HASH);
    expect(buildAnnotationsFixture(AREAS, HASH)).toBe(a);
    expect(buildAnnotationsFixture([...AREAS].reverse(), HASH)).toBe(a);
  });

  it('leaves the snow-park unannotated, gives one stakeholder, two orgs, and invents no seasons', () => {
    const text = buildAnnotationsFixture(AREAS, HASH);
    const result = parseAnnotations(JSON.parse(text), new Set(AREAS.map((a) => a.id)));
    expect(result.unannotatedAreaIds).toEqual(['way/5']);
    expect(result.organizations.size).toBe(2);
    const withStakeholders = [...result.annotations.values()].filter((a) => a.stakeholders.length > 0);
    expect(withStakeholders).toHaveLength(1);
    for (const annotation of result.annotations.values()) {
      for (const entry of annotation.activities) expect(entry.seasons).toEqual([]);
    }
  });

  it('the committed tests/fixtures/annotations.json is the replay of tests/fixtures/areas.geojson', () => {
    const { areas, inputSha256 } = readAreasFixture('tests/fixtures/areas.geojson');
    const committed = readFileSync('tests/fixtures/annotations.json', 'utf8');
    expect(committed).toBe(buildAnnotationsFixture(areas, inputSha256));
  });
});

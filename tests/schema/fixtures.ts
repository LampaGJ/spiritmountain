/** Valid samples, one per schema. Hand-built; the real seed file is parsed separately in organization.test.ts. */
export const validReplay = {
  inputHash: 'a'.repeat(64),
  codeCommit: 'b'.repeat(40),
  outputHash: 'c'.repeat(64),
  effect: 'expands',
};

/** What an annotations file embeds: the replay record without outputHash. */
export const validGeneratedFrom = {
  inputHash: 'a'.repeat(64),
  codeCommit: 'b'.repeat(40),
  effect: 'expands',
};

export const validLine = {
  type: 'LineString',
  coordinates: [
    [0, 0, 10],
    [5, 5, 12],
  ],
};

export const validPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0, 1],
      [4, 0, 1],
      [4, 4, 2],
      [0, 0, 1],
    ],
  ],
};

export const validArea = {
  id: 'way/123',
  kind: 'downhill-run',
  name: null,
  difficulty: null,
  geometry: validLine,
  osmTags: { 'piste:type': 'downhill' },
};

export const validFeature = {
  type: 'Feature',
  properties: {
    id: 'way/123',
    kind: 'downhill-run',
    name: null,
    difficulty: null,
    osmTags: { 'piste:type': 'downhill' },
  },
  geometry: validLine,
};

export const validFeatureCollection = {
  type: 'FeatureCollection',
  features: [validFeature],
};

export const validOrganization = {
  id: 'org-a',
  name: 'Org A',
  url: null,
  type: 'nonprofit',
  activities: ['adaptive'],
  sourceUrl: '',
  verified: false,
};

export const validAnnotation = {
  areaId: 'way/123',
  activities: [{ activity: 'lift-ride', seasons: [], notes: '' }],
  stakeholders: [{ orgId: 'org-a', role: 'maintains' }],
  notes: '',
};

export const validAnnotationsFile = {
  version: 1,
  generatedFrom: validGeneratedFrom,
  organizations: [validOrganization],
  annotations: [validAnnotation],
};

/** Returns a copy of `value` with key `from` renamed to `to`. */
export function renameKey(
  value: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  copy[to] = copy[from];
  delete copy[from];
  return copy;
}

/** Returns a copy of `value` with an extra unknown key. */
export function withExtraKey(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, unexpected: 1 };
}

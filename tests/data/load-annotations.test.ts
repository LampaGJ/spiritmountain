import { describe, expect, it } from 'vitest';
import { AnnotationsLoadError, loadAnnotations, parseAnnotations } from '../../src/data/load-annotations';
import { annotationsFileForAreas } from '../../src/schema/annotations-file';

const hex64 = 'a'.repeat(64);
const hex40 = 'b'.repeat(40);

/** An organization in #6's final shape: all seven fields. */
const orgA = { id: 'org-a', name: 'Org A', url: null, type: 'club', activities: [], sourceUrl: '', verified: false };
const note = (areaId: string, stakeholders: unknown[] = []) => ({ areaId, activities: [], stakeholders, notes: '' });

/** A file in #6's final shape: generatedFrom carries no outputHash (it lives in the sidecar). */
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generatedFrom: { inputHash: hex64, codeCommit: hex40, effect: 'expands' },
    organizations: [orgA],
    annotations: [note('way/1'), note('way/2')],
    ...overrides,
  };
}
const ids = new Set(['way/1', 'way/2', 'way/3']);

function withRenamedKey(): unknown {
  const raw = file();
  raw['annotations'] = [{ area_id: 'way/1', activities: [], stakeholders: [], notes: '' }, note('way/2')];
  return raw;
}

/** The rejection table: each row must fail the factory directly and fail closed through parseAnnotations. */
const rejections: { name: string; raw: unknown; known: ReadonlySet<string>; pattern: RegExp }[] = [
  { name: 'a duplicate areaId', raw: file({ annotations: [note('way/1'), note('way/1')] }), known: ids, pattern: /duplicate areaId way\/1/ },
  { name: 'a duplicate orgId', raw: file({ organizations: [orgA, orgA] }), known: ids, pattern: /duplicate organization id org-a/ },
  { name: 'an orphan areaId', raw: file(), known: new Set(['way/1']), pattern: /areaId way\/2 is not in areas\.geojson/ },
  {
    name: 'a dangling stakeholder orgId',
    raw: file({ annotations: [note('way/1', [{ orgId: 'org-missing', role: 'funds' }])] }),
    known: ids,
    pattern: /orgId org-missing matches no organization/,
  },
  { name: 'empty annotations', raw: file({ annotations: [] }), known: ids, pattern: /failed validation at annotations:/ },
  { name: 'empty organizations', raw: file({ organizations: [] }), known: ids, pattern: /failed validation at organizations:/ },
  { name: 'an extra key', raw: file({ extra: 1 }), known: ids, pattern: /failed validation at \(root\):/ },
  { name: 'a renamed key', raw: withRenamedKey(), known: ids, pattern: /failed validation at annotations\.0/ },
];

describe('parseAnnotations', () => {
  it('returns maps and the unannotated area ids', () => {
    const result = parseAnnotations(file(), ids);
    expect([...result.annotations.keys()]).toEqual(['way/1', 'way/2']);
    expect([...result.organizations.keys()]).toEqual(['org-a']);
    expect(result.unannotatedAreaIds).toEqual(['way/3']);
  });

  it.each(rejections)('fails closed on $name, matching the factory reject set', ({ raw, known, pattern }) => {
    expect(annotationsFileForAreas(known).safeParse(raw).success).toBe(false);
    expect(() => parseAnnotations(raw, known)).toThrow(AnnotationsLoadError);
    expect(() => parseAnnotations(raw, known)).toThrow(pattern);
  });

  it('names issues[0] and the total issue count', () => {
    const bad = file({
      annotations: [note('way/1', [{ orgId: 'org-missing', role: 'funds' }]), note('way/1')],
    });
    const result = annotationsFileForAreas(ids).safeParse(bad);
    if (result.success) throw new Error('expected the factory to reject the file');
    expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    expect(() => parseAnnotations(bad, ids)).toThrow(`(${result.error.issues.length} issues in total)`);
  });
});

describe('loadAnnotations', () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('parses a good response', async () => {
    const result = await loadAnnotations('/a.json', ids, ok(file()));
    expect(result.annotations.size).toBe(2);
  });

  it('throws AnnotationsLoadError on HTTP 404', async () => {
    await expect(loadAnnotations('/a.json', ids, ok({}, 404))).rejects.toThrow(/HTTP 404/);
  });

  it('throws AnnotationsLoadError on a network failure and on non-JSON', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(loadAnnotations('/a.json', ids, down)).rejects.toThrow(AnnotationsLoadError);
    const html = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await expect(loadAnnotations('/a.json', ids, html)).rejects.toThrow(/not valid JSON/);
  });
});

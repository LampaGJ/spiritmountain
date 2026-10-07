import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildingsManifestSchema } from '../../scripts/ingest/buildings-manifest-schema';
import { runFetchBuildings, validateBuildingsOverpass } from '../../scripts/ingest/fetch-buildings';
import { sha256Hex } from '../../scripts/ingest/replay';

const pt = [
  { lat: 46.7, lon: -92.2 },
  { lat: 46.7001, lon: -92.2 },
  { lat: 46.7001, lon: -92.2001 },
  { lat: 46.7, lon: -92.2 },
];
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 0.6,
    generator: 'test',
    osm3s: { timestamp_osm_base: '2026-10-06T00:00:00Z' },
    elements: [
      { type: 'way', id: 1, nodes: [1, 2, 3, 1], geometry: pt, tags: { building: 'house' } },
      { type: 'way', id: 2, nodes: [1, 2, 3, 1], geometry: pt, tags: { man_made: 'tower' } },
      { type: 'relation', id: 3, members: [], tags: { building: 'shed' } },
    ],
    ...overrides,
  };
}
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'no-code';
  }
  return 'none';
};

describe('validateBuildingsOverpass', () => {
  it('accepts a good envelope and counts ways, relations and tag families', () => {
    expect(validateBuildingsOverpass(bytesOf(envelope())).counts).toEqual({
      ways: 2,
      relations: 1,
      buildingTagged: 2,
      manMadeTagged: 1,
    });
  });
  it('BuildingsNotJson names the first bytes of an HTML 406 page', () => {
    expect(() => validateBuildingsOverpass(new TextEncoder().encode('<html>406'))).toThrow(
      /BuildingsNotJson: body is not JSON, starts "<html>406"/,
    );
  });
  it('BuildingsSchemaMismatch names the observed top-level keys on a renamed elements key', () => {
    const { elements, ...rest } = envelope();
    expect(() => validateBuildingsOverpass(bytesOf({ ...rest, element: elements }))).toThrow(
      /BuildingsSchemaMismatch: .*top-level keys observed: version, generator, osm3s, element/,
    );
  });
  it('BuildingsRemark on a 200 with a server remark', () => {
    expect(() => validateBuildingsOverpass(bytesOf(envelope({ remark: 'runtime error' })))).toThrow(
      /BuildingsRemark: server remark: runtime error/,
    );
  });
  it('BuildingsEmpty, BuildingsNoGeometry and BuildingsMissingFamily', () => {
    expect(code(() => validateBuildingsOverpass(bytesOf(envelope({ elements: [] }))))).toBe(
      'BuildingsEmpty',
    );
    const e = envelope();
    delete (e.elements[0] as Record<string, unknown>)['geometry'];
    expect(code(() => validateBuildingsOverpass(bytesOf(e)))).toBe('BuildingsNoGeometry');
    const f = envelope();
    f.elements = f.elements.slice(1, 2);
    expect(code(() => validateBuildingsOverpass(bytesOf(f)))).toBe('BuildingsMissingFamily');
  });
});

describe('runFetchBuildings', () => {
  const sandbox = () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'fetch-buildings-'));
    mkdirSync(path.join(dataDir, 'raw'));
    return dataDir;
  };
  const respond = (body: Uint8Array, status = 200, type = 'application/json') => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const requestImpl = (url: string, init?: RequestInit) => {
      seen.push(init === undefined ? { url } : { url, init });
      return Promise.resolve(
        new Response(body as BodyInit, { status, headers: { 'content-type': type } }),
      );
    };
    return { requestImpl, seen };
  };

  it('sends the query with a User-Agent, writes the bytes unchanged and a matching manifest', async () => {
    const dataDir = sandbox();
    const body = bytesOf(envelope());
    const { requestImpl, seen } = respond(body);
    const m = await runFetchBuildings({ dataDir, requestImpl, now: () => 0 });
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('spiritmountain-poc/0.1');
    expect(String(seen[0]?.init?.body)).toContain('out%20geom');
    const written = readFileSync(path.join(dataDir, 'raw/overpass-buildings.json'));
    expect(sha256Hex(written)).toBe(m.sha256);
    expect(Buffer.compare(written, Buffer.from(body))).toBe(0);
    expect(
      BuildingsManifestSchema.parse(
        JSON.parse(readFileSync(path.join(dataDir, 'raw/buildings-manifest.json'), 'utf8')),
      ),
    ).toEqual(m);
  });

  it('refuses to overwrite without force (AlreadyPinned), and force supersedes', async () => {
    const dataDir = sandbox();
    const { requestImpl } = respond(bytesOf(envelope()));
    await runFetchBuildings({ dataDir, requestImpl });
    await expect(runFetchBuildings({ dataDir, requestImpl })).rejects.toMatchObject({
      code: 'AlreadyPinned',
    });
    await expect(runFetchBuildings({ dataDir, requestImpl, force: true })).resolves.toBeTruthy();
  });

  it('rejects a blank User-Agent before any request (the 406 guard)', async () => {
    const dataDir = sandbox();
    const { requestImpl, seen } = respond(bytesOf(envelope()));
    await expect(runFetchBuildings({ dataDir, requestImpl, userAgent: ' ' })).rejects.toMatchObject(
      { code: 'MissingUserAgent' },
    );
    expect(seen).toEqual([]);
  });

  it('names a 406 and an empty 200 body, writing nothing', async () => {
    const a = sandbox();
    await expect(
      runFetchBuildings({ dataDir: a, requestImpl: respond(new Uint8Array(), 406).requestImpl }),
    ).rejects.toThrow(/BuildingsHttpError: HTTP 406/);
    const b = sandbox();
    await expect(
      runFetchBuildings({ dataDir: b, requestImpl: respond(new Uint8Array()).requestImpl }),
    ).rejects.toThrow(/BuildingsEmpty: response body is empty/);
    expect(existsSync(path.join(b, 'raw/overpass-buildings.json'))).toBe(false);
    expect(existsSync(path.join(b, 'raw/buildings-manifest.json'))).toBe(false);
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = 'scripts/lint-determinism.sh';
const patternFile = 'scripts/determinism-patterns.txt';

function run(dir: string, ...extras: string[]) {
  return spawnSync('bash', [script, dir, ...extras], { encoding: 'utf8' });
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'determinism-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('scripts/lint-determinism.sh', () => {
  it('exits 0 on a clean directory', () => {
    expect(run(fixture({ 'ok.ts': 'export const x = 1;\n' })).status).toBe(0);
  });

  // One positive control per hazard in ~/.claude/reproducible-data-manipulation.md, so a pattern
  // that silently stops matching fails here instead of reporting clean.
  it.each([
    ['Date.now', 'export const t = Date.now();\n'],
    ['new Date() with no argument', 'export const d = new Date();\n'],
    ['Math.random', 'export const r = Math.random();\n'],
    ['crypto.randomUUID', 'export const u = crypto.randomUUID();\n'],
    ['localeCompare', "export const c = 'a'.localeCompare('b');\n"],
    ['toLocaleString', 'export const s = (1).toLocaleString();\n'],
    ['Set built from awaited results', 'export const s = new Set(await Promise.resolve([1]));\n'],
    ['Promise.race', 'export const p = Promise.race([]);\n'],
    [
      'for await',
      'export async function f(x: AsyncIterable<number>) { for await (const v of x) void v; }\n',
    ],
    ['fetch call', "export const r = fetch('https://example.com');\n"],
    ['injected fetchImpl', 'export const r = (fetchImpl: () => void) => fetchImpl();\n'],
    [
      'model SDK import',
      "import { Anthropic } from '@anthropic-ai/sdk';\nexport const a = Anthropic;\n",
    ],
  ])('exits 1 on %s', (_name, body) => {
    expect(run(fixture({ 'bad.ts': body })).status).toBe(1);
  });

  it('ignores fetch.ts, which may record fetched-at', () => {
    expect(run(fixture({ 'fetch.ts': 'export const t = Date.now();\n' })).status).toBe(0);
  });

  it('ignores imagery.ts, the second ingestion step', () => {
    expect(run(fixture({ 'imagery.ts': 'export const t = Date.now();\n' })).status).toBe(0);
  });

  it('ignores imagery-inset.ts, the native-resolution inset ingestion step', () => {
    expect(run(fixture({ 'imagery-inset.ts': 'export const t = Date.now();\n' })).status).toBe(0);
  });

  it('ignores sky.ts and fetch-buildings.ts, ingestion steps that record fetched-at', () => {
    expect(run(fixture({ 'sky.ts': 'export const t = Date.now();\n' })).status).toBe(0);
    expect(run(fixture({ 'fetch-buildings.ts': 'export const t = Date.now();\n' })).status).toBe(0);
  });

  it('exits 2 when the directory is missing', () => {
    expect(run('/nonexistent-determinism-dir').status).toBe(2);
  });

  it('scans an extra file that exists and skips one that does not exist yet', () => {
    const dir = fixture({ 'ok.ts': 'export const x = 1;\n' });
    const extraDir = fixture({ 'drape.ts': 'export const t = Date.now();\n' });
    expect(run(dir, join(extraDir, 'drape.ts')).status).toBe(1);
    expect(run(dir, join(dir, 'not-there-yet.ts')).status).toBe(0);
  });

  it('keeps one pattern list: no blank lines, valid regexes, at least one per hazard', () => {
    const text = readFileSync(patternFile, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.slice(0, -1).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(7);
    for (const line of lines) {
      expect(line).not.toBe('');
      expect(() => new RegExp(line)).not.toThrow();
    }
  });
});

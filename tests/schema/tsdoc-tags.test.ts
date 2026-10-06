import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REQUIRED = ['@displayName', '@strategicPurpose', '@tacticalObjective'];

/** Returns the exported declarations in `source` whose preceding TSDoc block lacks one of the three tags. */
export function untaggedExports(source: string): string[] {
  const lines = source.split('\n');
  const problems: string[] = [];
  lines.forEach((line, index) => {
    const match = /^export (?:const (\w+Schema)\b|function (\w+))/.exec(line);
    if (!match) return;
    const name = match[1] ?? match[2] ?? '?';
    let end = index - 1;
    while (end >= 0 && lines[end]?.trim() === '') end -= 1;
    if (end < 0 || !(lines[end] ?? '').trim().endsWith('*/')) {
      problems.push(`${name}: no TSDoc block`);
      return;
    }
    let start = end;
    while (start >= 0 && !(lines[start] ?? '').includes('/**')) start -= 1;
    const block = lines.slice(start, end + 1).join('\n');
    for (const tag of REQUIRED) if (!block.includes(tag)) problems.push(`${name}: missing ${tag}`);
  });
  return problems;
}

describe('TSDoc tags on every exported schema', () => {
  const dir = new URL('../../src/schema/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('finds the schema files (instrument check)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('flags a declaration with a missing tag (instrument check)', () => {
    const bad = '/**\n * @displayName X\n */\nexport const XSchema = 1;\n';
    expect(untaggedExports(bad)).toEqual([
      'XSchema: missing @strategicPurpose',
      'XSchema: missing @tacticalObjective',
    ]);
  });

  for (const file of files) {
    it(`${file} has all three tags on every exported schema`, () => {
      expect(untaggedExports(readFileSync(new URL(file, dir), 'utf8'))).toEqual([]);
    });
  }
});

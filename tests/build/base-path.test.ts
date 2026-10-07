import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');

describe('vite base path', () => {
  it('uses /spiritmountain/ when GITHUB_PAGES is set and / otherwise', () => {
    expect(source).toContain("process.env.GITHUB_PAGES ? '/spiritmountain/' : '/'");
  });

  it('still emits assets as files (assetsInlineLimit 0)', () => {
    expect(source).toMatch(/assetsInlineLimit:\s*0/);
  });
});

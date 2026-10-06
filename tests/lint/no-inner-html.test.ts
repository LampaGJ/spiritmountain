import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

async function lint(code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath: 'src/ui/__lint_fixture__.ts' });
  return result?.messages ?? [];
}

describe('innerHTML ban (npm run lint enforces it on src/)', () => {
  it.each([
    ['innerHTML', 'const e = document.body; e.innerHTML = "x";'],
    ['outerHTML', 'const e = document.body; e.outerHTML = "x";'],
    ['insertAdjacentHTML', 'document.body.insertAdjacentHTML("beforeend", "x");'],
  ])('flags %s', async (_name, code) => {
    const messages = await lint(code);
    expect(messages.some((m) => m.ruleId === 'no-restricted-properties')).toBe(true);
  });

  it('flags document.write', async () => {
    const messages = await lint('document.write("x");');
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('passes textContent', async () => {
    const messages = await lint('document.body.textContent = "x";');
    expect(messages).toEqual([]);
  });
});

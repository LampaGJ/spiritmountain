import { expectTypeOf, it } from 'vitest';
import type { progress } from '/Users/graham/.claude/lib/progress.mjs';

// Compile-time check: npm run typecheck fails if scripts/progress.d.ts stops resolving the import.
it('types the global progress helper', () => {
  expectTypeOf<typeof progress>().toBeFunction();
  expectTypeOf<ReturnType<typeof progress>['tick']>().toBeFunction();
});

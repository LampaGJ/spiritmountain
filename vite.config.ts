import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    // Inline nothing: terrain.json (a few hundred bytes) must be emitted as a file like terrain.f32.
    assetsInlineLimit: 0,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});

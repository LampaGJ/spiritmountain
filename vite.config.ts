import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the site under /spiritmountain/; the Pages workflow sets GITHUB_PAGES=1. Everywhere else the base is the root.
  base: process.env.GITHUB_PAGES ? '/spiritmountain/' : '/',
  build: {
    // Inline nothing: terrain.json (a few hundred bytes) must be emitted as a file like terrain.f32.
    assetsInlineLimit: 0,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});

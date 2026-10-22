import { defineConfig } from 'tsup';

/**
 * Workspace packages (`@second-brain/core`, `@second-brain/schema`) export TypeScript source and
 * are never published, so they (and their own dependencies) are bundled into `dist/index.js`.
 * `@napi-rs/keyring` ships a native binding per platform and must stay a real runtime dependency.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
  noExternal: [/^@second-brain\//, 'picocolors'],
  external: ['@napi-rs/keyring'],
});

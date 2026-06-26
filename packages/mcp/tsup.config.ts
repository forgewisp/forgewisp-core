import { defineConfig } from 'tsup';

// ESM + CJS only (no IIFE/global build): unlike @forgewisp/bundled-tools, this
// package pulls in the @modelcontextprotocol/sdk runtime dependency, and
// inlining that SDK into a self-contained IIFE would be both heavy and fragile
// (it relies on browser-native `fetch`/`EventSource`). Consumers bundle this
// package through their app bundler (Vite/webpack/etc.), which resolves the
// externalized SDK and peer `@forgewisp/core`. tsup externalizes packages
// declared in `dependencies`/`peerDependencies` automatically.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  treeshake: true,
  outExtension({ format }) {
    if (format === 'esm') return { js: '.mjs' };
    return { js: '.cjs' };
  },
});

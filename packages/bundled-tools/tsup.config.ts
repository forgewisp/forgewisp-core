import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs', 'iife'],
  dts: true,
  sourcemap: true,
  clean: true,
  globalName: 'ForgewispBundledTools',
  minify: false,
  splitting: false,
  treeshake: true,
  outExtension({ format }) {
    if (format === 'esm') return { js: '.mjs' };
    if (format === 'iife') return { js: '.global.js' };
    return { js: '.cjs' };
  },
});

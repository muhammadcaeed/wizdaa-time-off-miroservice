import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC (via the plugin below) handles TS + decorator metadata; disable the
  // default Oxc transform so the two don't overlap.
  oxc: false,
  test: {
    globals: true,
    root: './',
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: true,
    include: ['apps/**/*.e2e-spec.ts', 'test/**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  plugins: [swc.vite()],
});

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
    include: ['apps/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e-spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['apps/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/main.ts'],
    },
  },
  plugins: [swc.vite()],
});

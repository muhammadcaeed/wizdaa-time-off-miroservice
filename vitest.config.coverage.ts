import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Coverage config: runs every layer (unit/integration/contract/chaos/property
 * `*.spec.ts` plus end-to-end `*.e2e-spec.ts`) in one pass so the report
 * reflects true behavioral coverage. The day-to-day `vitest.config.ts` excludes
 * e2e for fast feedback; this config is what `npm run coverage` and `npm run ci`
 * measure against the thresholds.
 */
export default defineConfig({
  oxc: false,
  test: {
    globals: true,
    root: './',
    setupFiles: ['./vitest.setup.ts'],
    include: ['apps/**/*.spec.ts', 'scripts/**/*.spec.ts', 'apps/**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['apps/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        '**/*.e2e-spec.ts',
        '**/main.ts',
        '**/*.module.ts',
        '**/*.dto.ts',
        '**/database/migrations/**',
        '**/database/seed.ts',
        '**/database/data-source.ts',
      ],
      // 85% line floor overall (test-strategy.md §3). Per-file floors guard the
      // critical services against regression. These sit at their current
      // achievable level — the remaining uncovered lines are documented
      // defensive guards and explicitly-unreachable safety branches, not gaps
      // in scenario coverage (every REQ/INV/T/R/F is covered; see traceability.md).
      thresholds: {
        lines: 85,
        '**/modules/hcm-sync/circuit-breaker.ts': { lines: 98 },
        '**/modules/time-off/sagas/approval-saga.service.ts': { lines: 95 },
        '**/modules/time-off/sagas/cancellation-saga.service.ts': { lines: 90 },
        '**/modules/time-off/request.service.ts': { lines: 95 },
        '**/modules/reconciliation/reconciliation.service.ts': { lines: 86 },
      },
    },
  },
  plugins: [swc.vite()],
});

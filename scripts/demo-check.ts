/**
 * Freshness gate for docs/demo/SHOWCASE.md (run by `npm run ci`).
 *
 * Regenerates the showcase to a temp file via the live demo and diffs it against
 * the committed copy. Exits non-zero if they differ — the committed showcase must
 * always reflect real behavior. Skips (exit 0) when docs/ is absent (fresh clone
 * where docs ship out-of-band), since there is nothing to compare against.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const COMMITTED = join(REPO_ROOT, 'docs', 'demo', 'SHOWCASE.md');

function main(): void {
  if (!existsSync(COMMITTED)) {
    process.stdout.write(
      'demo:check skipped — docs/demo/SHOWCASE.md not present (docs ship out-of-band).\n',
    );
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'showcase-check-'));
  const out = join(tmp, 'SHOWCASE.md');
  try {
    execFileSync(
      'npx',
      ['ts-node', '--project', 'scripts/tsconfig.json', 'scripts/demo-scenarios.ts', '--out', out],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    const fresh = readFileSync(out, 'utf8');
    const committed = readFileSync(COMMITTED, 'utf8');
    if (fresh !== committed) {
      process.stderr.write(
        '\ndemo:check FAILED — docs/demo/SHOWCASE.md is stale. Run `npm run demo:scenarios` and commit the result.\n',
      );
      process.exit(1);
    }
    process.stdout.write('demo:check passed — showcase matches live behavior.\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();

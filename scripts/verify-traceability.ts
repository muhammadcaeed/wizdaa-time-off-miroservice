/**
 * Traceability verifier (plan 08).
 *
 * Enforces the verifier contract documented in `docs/trd/test-strategy.md` §4:
 *
 *   Requirement universe = every bold `**REQ-…**` heading in `requirements.md`
 *                          ∪ the five invariants INV-01..05 (TRD §4.3).
 *
 * The build fails if any of these hold:
 *   1. A test `@req` annotation references an ID outside the universe.
 *   2. A requirement in the universe has no covering test annotation.
 *   3. A `traceability.md` row references a test file or test name that does
 *      not exist in the codebase.
 *   4. A requirement in the universe is absent from `traceability.md`
 *      (documentation drift between requirements and the matrix).
 *
 * T-/R-/F- scenario IDs are matrix cross-references, not requirements: their
 * rows are validated for file/name resolution (rule 3) but they are not
 * subject to the coverage check (rule 2).
 *
 * The exported {@link verifyTraceability} takes explicit paths so the meta-tests
 * can point it at fixtures; the CLI runner at the bottom uses the real repo.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The five invariants are defined in TRD §4.3, not as REQ headings. */
export const INVARIANT_IDS = ['INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05'];

const REQ_ID = '[A-Z]+-[0-9]+[a-z]?';
const REQ_TAG_RE = new RegExp(`@req\\s+(REQ-${REQ_ID}|INV-[0-9]+)`, 'g');
const REQ_HEADING_RE = new RegExp(`\\*\\*(REQ-${REQ_ID})\\*\\*`, 'g');
const DESCRIBE_IT_RE = /\b(?:describe|it|test)\s*\(\s*(['"`])([\s\S]*?)\1/g;

export interface VerifyOptions {
  /** Repo-root-relative directories scanned for spec files. */
  readonly testRoots: string[];
  readonly requirementsPath: string;
  readonly traceabilityPath: string;
  /** Repo root every relative path resolves against. */
  readonly repoRoot: string;
  /** Override the invariant set (meta-tests only). */
  readonly invariantIds?: string[];
}

export interface VerifyResult {
  readonly errors: string[];
  /** id -> list of `file::describe` locations that annotate it. */
  readonly coverage: Map<string, string[]>;
}

interface SpecFile {
  /** Repo-relative path. */
  readonly path: string;
  /** Tags found, each paired with the title of the describe/it it precedes. */
  readonly tags: { id: string; title: string }[];
  /** Every describe/it title in the file, for matrix name resolution. */
  readonly titles: Set<string>;
}

function listFiles(dir: string, suffixes: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, suffixes));
    else if (suffixes.some((s) => entry.endsWith(s))) out.push(full);
  }
  return out;
}

/**
 * Parses one spec file: associates each `@req` tag with the title of the next
 * `describe`/`it` that follows it, and collects every title for name lookups.
 */
function parseSpec(repoRoot: string, absPath: string): SpecFile {
  const src = readFileSync(absPath, 'utf8');
  const titles = new Set<string>();
  for (const m of src.matchAll(DESCRIBE_IT_RE)) titles.add(m[2]);

  const tags: { id: string; title: string }[] = [];
  // Walk tags in order; for each, find the first describe/it title after it.
  const titleOffsets: { idx: number; title: string }[] = [];
  for (const m of src.matchAll(DESCRIBE_IT_RE)) {
    titleOffsets.push({ idx: m.index ?? 0, title: m[2] });
  }
  for (const m of src.matchAll(REQ_TAG_RE)) {
    const at = m.index ?? 0;
    const next = titleOffsets.find((t) => t.idx > at);
    tags.push({ id: m[1], title: next?.title ?? '' });
  }
  return { path: relative(repoRoot, absPath), tags, titles };
}

/** Bold `**REQ-…**` headings plus the fixed invariant set. */
export function loadRequirementUniverse(
  requirementsMarkdown: string,
  invariantIds: string[] = INVARIANT_IDS,
): Set<string> {
  const universe = new Set<string>(invariantIds);
  for (const m of requirementsMarkdown.matchAll(REQ_HEADING_RE)) {
    universe.add(m[1]);
  }
  return universe;
}

interface MatrixRow {
  readonly id: string;
  readonly file: string;
  readonly name: string;
}

/**
 * Parses every markdown table row of the shape `| ID | … | file | name |`.
 * The first cell is the requirement/scenario ID; the last two are the test
 * file and test name. Header and separator rows are skipped.
 */
export function parseTraceabilityRows(markdown: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    const id = cells[0];
    if (!/^(REQ-|INV-|T-|R-|F-)/.test(id)) continue; // skips header/separator
    const file = stripCode(cells[cells.length - 2]);
    const name = stripCode(cells[cells.length - 1]);
    rows.push({ id, file, name });
  }
  return rows;
}

function stripCode(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

export function verifyTraceability(opts: VerifyOptions): VerifyResult {
  const errors: string[] = [];
  const invariantIds = opts.invariantIds ?? INVARIANT_IDS;
  const reqMd = readFileSync(resolve(opts.repoRoot, opts.requirementsPath), 'utf8');
  const traceMd = readFileSync(resolve(opts.repoRoot, opts.traceabilityPath), 'utf8');
  const universe = loadRequirementUniverse(reqMd, invariantIds);

  const specPaths = opts.testRoots.flatMap((r) =>
    listFiles(resolve(opts.repoRoot, r), ['.spec.ts', '.e2e-spec.ts']),
  );
  const specs = specPaths.map((p) => parseSpec(opts.repoRoot, p));

  // Rule 1: unknown @req IDs. + build coverage map.
  const coverage = new Map<string, string[]>();
  for (const spec of specs) {
    for (const { id, title } of spec.tags) {
      if (!universe.has(id)) {
        errors.push(
          `[unknown-req] ${spec.path} annotates @req ${id}, which is not a defined requirement.`,
        );
      }
      const loc = `${spec.path}::${title}`;
      const list = coverage.get(id) ?? [];
      list.push(loc);
      coverage.set(id, list);
    }
  }

  // Rule 2: every requirement covered by at least one annotation.
  for (const id of [...universe].sort()) {
    if (!coverage.has(id)) {
      errors.push(`[uncovered-req] ${id} has no covering test (@req annotation).`);
    }
  }

  // Build a lookup of repo-relative spec path -> titles, for matrix resolution.
  const byPath = new Map(specs.map((s) => [s.path, s.titles]));
  const rows = parseTraceabilityRows(traceMd);

  // Rule 3: matrix rows resolve to a real file and a real test name.
  const matrixIds = new Set<string>();
  for (const row of rows) {
    matrixIds.add(row.id);
    const titles = byPath.get(row.file);
    if (!titles) {
      errors.push(`[stale-row] ${row.id}: traceability file "${row.file}" does not exist.`);
      continue;
    }
    if (row.name && !titleMatches(titles, row.name)) {
      errors.push(`[stale-row] ${row.id}: test name "${row.name}" not found in ${row.file}.`);
    }
  }

  // Rule 4: every requirement appears in the matrix (requirements <-> matrix drift).
  for (const id of [...universe].sort()) {
    if (!matrixIds.has(id)) {
      errors.push(`[matrix-drift] ${id} is defined but absent from traceability.md.`);
    }
  }

  return { errors, coverage };
}

/** A matrix name resolves if it equals, or is a substring of, a real title. */
function titleMatches(titles: Set<string>, name: string): boolean {
  if (titles.has(name)) return true;
  for (const t of titles) {
    if (t.includes(name) || name.includes(t)) return true;
  }
  return false;
}

const REPO_ROOT = resolve(__dirname, '..');

function main(): void {
  const result = verifyTraceability({
    repoRoot: REPO_ROOT,
    testRoots: ['apps'],
    requirementsPath: 'docs/trd/requirements.md',
    traceabilityPath: 'docs/trd/traceability.md',
  });

  if (process.argv.includes('--report')) {
    for (const id of [...result.coverage.keys()].sort()) {
      process.stdout.write(`${id}\n`);
      for (const loc of result.coverage.get(id) ?? []) {
        process.stdout.write(`    ${loc}\n`);
      }
    }
  }

  if (result.errors.length > 0) {
    process.stderr.write(`\nTraceability verification FAILED (${result.errors.length}):\n`);
    for (const e of result.errors) process.stderr.write(`  ✗ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('Traceability verification passed.\n');
}

if (require.main === module) main();

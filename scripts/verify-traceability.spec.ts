import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyTraceability, type VerifyOptions } from './verify-traceability';

/**
 * Meta-tests for the traceability verifier. Each builds a tiny fixture repo in a
 * temp dir and asserts the verifier's pass/fail behavior for the contract in
 * `test-strategy.md` §4.
 */
describe('verifyTraceability (CI gate meta-tests)', () => {
  let root: string;

  const SPEC = [
    '/**',
    ' * @req REQ-FOO-01',
    ' */',
    "describe('foo behaves', () => {",
    "  it('does the thing', () => {});",
    '});',
  ].join('\n');

  const REQUIREMENTS = '**REQ-FOO-01** (Ubiquitous): The system shall foo.\n';

  const TRACEABILITY = [
    '| REQ ID | Behavior | Test file | Test |',
    '|---|---|---|---|',
    '| REQ-FOO-01 | foos | `specs/foo.spec.ts` | foo behaves |',
    '',
  ].join('\n');

  function opts(): VerifyOptions {
    return {
      repoRoot: root,
      testRoots: ['specs'],
      requirementsPath: 'requirements.md',
      traceabilityPath: 'traceability.md',
      invariantIds: [], // fixtures define no invariants
    };
  }

  function write(rel: string, content: string): void {
    writeFileSync(join(root, rel), content);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trace-verify-'));
    mkdirSync(join(root, 'specs'));
    write('specs/foo.spec.ts', SPEC);
    write('requirements.md', REQUIREMENTS);
    write('traceability.md', TRACEABILITY);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes on a consistent fixture', () => {
    expect(verifyTraceability(opts()).errors).toEqual([]);
  });

  it('fails on a @req annotation referencing an unknown REQ-ID', () => {
    write(
      'specs/foo.spec.ts',
      SPEC.replace('@req REQ-FOO-01', '@req REQ-FOO-01\n * @req REQ-GHOST-99'),
    );
    const errors = verifyTraceability(opts()).errors;
    expect(errors.some((e) => e.includes('[unknown-req]') && e.includes('REQ-GHOST-99'))).toBe(
      true,
    );
  });

  it('fails on a requirement with no covering test', () => {
    write('requirements.md', REQUIREMENTS + '**REQ-BAR-02** (Ubiquitous): The system shall bar.\n');
    const errors = verifyTraceability(opts()).errors;
    expect(errors.some((e) => e.includes('[uncovered-req]') && e.includes('REQ-BAR-02'))).toBe(
      true,
    );
  });

  it('fails on a traceability row referencing a non-existent test file', () => {
    write('traceability.md', TRACEABILITY.replace('specs/foo.spec.ts', 'specs/missing.spec.ts'));
    const errors = verifyTraceability(opts()).errors;
    expect(errors.some((e) => e.includes('[stale-row]') && e.includes('missing.spec.ts'))).toBe(
      true,
    );
  });

  it('fails on a traceability row referencing a non-existent test name', () => {
    write('traceability.md', TRACEABILITY.replace('| foo behaves |', '| no such test |'));
    const errors = verifyTraceability(opts()).errors;
    expect(errors.some((e) => e.includes('[stale-row]') && e.includes('no such test'))).toBe(true);
  });

  it('fails on requirements/matrix drift (requirement absent from matrix)', () => {
    write('requirements.md', REQUIREMENTS + '**REQ-BAR-02** (Ubiquitous): The system shall bar.\n');
    write(
      'specs/foo.spec.ts',
      SPEC.replace('@req REQ-FOO-01', '@req REQ-FOO-01\n * @req REQ-BAR-02'),
    );
    // REQ-BAR-02 is now covered by a test but missing from traceability.md.
    const errors = verifyTraceability(opts()).errors;
    expect(errors.some((e) => e.includes('[matrix-drift]') && e.includes('REQ-BAR-02'))).toBe(true);
  });
});

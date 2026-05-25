# Test Strategy

Companion to `TRD.md`. The TRD frames test rigor as a primary design concern; this file specifies the layers, tooling, mock-HCM strategy, coverage approach, and the property-based testing pattern. Requirement-to-test mapping lives in `traceability.md`.

## 1. Layers

Seven layers, each with a distinct purpose. Fast layers first; expensive layers last.

| Layer | Purpose | Scope | Tooling |
|---|---|---|---|
| **Unit** | Pure logic in isolation | State-machine transitions, balance math, validation, error mapping, circuit breaker FSM, retry policy | Vitest, in-process |
| **Integration** | Service + DB, no external HTTP | Repository layer, transaction boundaries, version-check semantics, audit append-only | Vitest, `@nestjs/testing`, real SQLite (file-backed) |
| **Contract** | HCM client honors the assumed contract | Request shape, response parsing, idempotency-key construction, expected-total arithmetic check on adjust responses | Vitest, in-process mock HCM module |
| **End-to-end** | Full HTTP through the service | Happy paths for every state transition, auth, pagination, idempotency, error responses | Vitest + supertest, out-of-process mock HCM |
| **Concurrency** | Real parallelism against running service | R-01 through R-06 from TRD §10.3 | Vitest with `Promise.all` concurrent calls, supertest |
| **Chaos** | Failure injection | F-01 through F-08, breaker state transitions, retry exhaustion | Vitest, out-of-process mock HCM with scenario control plane |
| **Property-based** | Invariants under random operation sequences | INV-01 through INV-05 over generated traces | Vitest + fast-check |

**CI execution order**: unit → integration → contract → e2e → concurrency → chaos → property-based. Property-based tests run with a fixed seed for reproducibility; the seed rotates weekly to explore new sequences.

## 2. Mock HCM strategy

The mock HCM (full spec in `mock-hcm.md`) is used in two modes:

- **In-process**: instantiated as a NestJS module within the test harness. Used by contract tests and e2e tests where startup overhead matters. Faster, simpler.
- **Out-of-process**: spawned as a child process listening on a fresh port per test suite. Used by e2e, concurrency, and chaos tests where realistic HTTP semantics (timeouts, connection failures, concurrent calls) matter. Slower, more realistic.

The standard pattern per test:

```
beforeEach: mock.reset()
arrange:    mock.setScenario({ adjust: 'ambiguous-success' })
            mock.injectBalance(employeeId, locationId, 10)
act:        service call(s)
assert:     request state, balance state, audit log entries
```

Scenarios: `normal`, `slow`, `flaky` (configurable failure rate), `ambiguous-success`, `down`, `unverifiable-success`. New scenarios are added as tests need them. See `mock-hcm.md` for full scenario definitions and the control-plane API.

## 3. Coverage approach

Two axes, evaluated together.

**Line and branch coverage.** Target 85% line coverage overall, with 100% line coverage on the critical services: reservation logic, approval saga, cancellation saga, reconciliation algorithm, circuit breaker. Enforced in CI; a drop below threshold fails the build.

**Scenario coverage.** The harder, more meaningful axis. Every item below is covered by at least one test:

- All 12 state transitions (T-01 through T-12 from TRD §5.2)
- All 6 race scenarios (R-01 through R-06 from TRD §10.3)
- All 8 failure modes (F-01 through F-08 from TRD §11.1), including the stuck-state sweep's resolution of F-07
- All 5 invariants (INV-01 through INV-05 from TRD §4.2), verified under random sequences via property-based testing
- All functional requirements in `requirements.md` (REQ-LIFE-*, REQ-BAL-*, REQ-SYNC-*, REQ-REC-*, REQ-DEF-*), via the traceability map in `traceability.md`

Scenario coverage is the lead indicator; line coverage is the lagging one. A change that adds branches without adding scenarios is suspect.

## 4. Traceability mechanism

Every REQ-* and INV-* maps to one or more test cases. Mapping lives in `traceability.md` and is verified in CI: a missing or stale mapping fails the build.

The CI verifier parses requirement IDs from test annotations (a `@req` JSDoc tag on each `describe` block) and matches them against `traceability.md`. Example:

```typescript
/**
 * @req REQ-LIFE-04
 * @req REQ-DEF-05
 */
describe('approval saga commits APPROVED on confirmed HCM decrement', () => {
  it('updates balance, request, and audit in one transaction', async () => {
    // ...
  });
});
```

**Verifier contract** (implemented in `scripts/verify-traceability.ts`, run via `npm run verify:traceability`):

- **Requirement universe** = every bold `**REQ-…**` heading in `requirements.md` ∪ the five invariants `INV-01..05` (defined in TRD §4.2, not as REQ headings). Prose mentions of an ID (e.g. supersession notes) are not definitions; only bold headings count, so retired IDs like `REQ-DEF-02` drop out of the universe cleanly.
- **`@req` tags** are associated with the `describe`/`it` they precede; an ID's coverage is the set of those locations.
- **`T-`/`R-`/`F-` scenario IDs** are matrix cross-references, not requirements. Their rows are checked for file/name resolution (rule 3 below) but are exempt from the coverage check (rule 2).

A build fails if:
- **[unknown-req]** a test annotation references an ID outside the requirement universe
- **[uncovered-req]** a requirement in the universe has no covering `@req` annotation
- **[stale-row]** a row in `traceability.md` references a test file or test name that doesn't exist
- **[matrix-drift]** a requirement in the universe is absent from `traceability.md`

The verifier's own behavior is covered by meta-tests in `scripts/verify-traceability.spec.ts` (one per failure mode plus the passing case).

## 5. Property-based testing for invariants

Property-based testing is the layer that delivers the most assurance for the invariants. Hand-written tests cover specific cases; property-based testing explores the state space.

The pattern, using fast-check:

```typescript
const NUM_RUNS = process.env.CI ? 1000 : 200;

test('INV-02: total - reserved >= 0 under random operation sequences', async () => {
  await fc.assert(
    fc.asyncProperty(
      operationSequence({ maxLength: 50, employees: 5, locations: 2 }),
      async (operations) => {
        await resetState();
        for (const op of operations) {
          await applyOperation(op); // each call exercises real service code
        }
        const balances = await balanceRepo.findAll();
        for (const b of balances) {
          expect(b.total_days - b.reserved_days).toBeGreaterThanOrEqual(0);
        }
      }
    ),
    { numRuns: NUM_RUNS }
  );
});
```

`numRuns` is environment-driven: 200 during local iteration (fast feedback), 1000 in CI (broader state-space coverage). The seed is logged on every run and can be replayed manually; failing seeds are committed as fixed unit tests so the same shrunk reproduction guards future development.

The generator emits operations drawn from the legal API surface: submit, approve, reject, cancel, retry-approval, retry-cancellation, reconcile, plus HCM-side perturbations (anniversary grants, drift). Generator probabilities are tuned to bias toward interesting cases (concurrent submissions on the same balance, reconciliation interleaved with sagas, retries after failures).

Properties verified:

- INV-01 through INV-05 hold after every sequence
- HCM idempotency: applying the same logical operation twice has the effect of applying it once
- Reservation conservation: every reservation is either committed (APPROVED) or released (REJECTED, CANCELLED, APPROVAL_FAILED, CANCELLATION_FAILED); no reservation is ever leaked

When a property fails, fast-check shrinks the failing sequence to a minimal reproduction. That reproduction is then committed as a fixed unit test, ensuring the same bug can't recur.

## 6. Test data management

- **Fixtures**: a JSON seed file at `test/fixtures/employees.json` provides a baseline org structure (10 employees, 2 locations, 1 manager) consistent across all test layers
- **Isolation**: every test starts from a clean DB. Integration tests use file-backed SQLite in a temp directory; e2e tests use a fresh DB per spec
- **Mock HCM state**: reset between tests via `mock.reset()` in `beforeEach`
- **Deterministic IDs**: ULIDs in production, fixed test IDs (`emp_001`, `loc_001`, `req_001`) in unit and integration tests for readable assertions

## 7. What is not tested at this layer

- **Real HCM**: no contract tests against a real vendor sandbox in scope. The mock HCM defines the assumed contract; vendor drift would be caught by production integration tests added post-deployment
- **Load and stress**: the latency targets in `requirements.md` §2.1 are validated at p50/p95 under the concurrency layer but not under sustained load. Load testing is a deploy-time activity
- **UI / frontend**: the service is backend-only
- **Manual end-to-end flows**: every flow has automated coverage; manual QA is not part of the CI gate

# Time-Off Microservice

A NestJS + TypeScript + SQLite microservice that manages the lifecycle of time-off requests (submit → approve/reject → cancel) while keeping per-employee, per-location balances consistent with an external HCM that is the source of truth. The HCM has multiple independent writers and unreliable error reporting, so the service mirrors HCM state defensively: a reservation model for instant employee feedback, sagas with an arithmetic-verified HCM round-trip for approvals/cancellations, a circuit breaker + retry for HCM faults, and scheduled reconciliation to absorb changes that originate outside this service.

- **Design narrative (the TRD):** [`docs/TRD.md`](docs/TRD.md) — the source of truth, with the four challenges, the chosen solution, and alternatives.
- **How it was built:** [`docs/plan/README.md`](docs/plan/README.md) — the eight-cycle vertical-slice development plan.
- **Proof of coverage:** [`docs/trd/traceability.md`](docs/trd/traceability.md) — every requirement and invariant mapped to a test, CI-enforced.

---

## The four challenges from the brief, and where each is solved

The assignment names four interesting challenges. Each maps to a TRD section, a development cycle, and the tests that prove it. Run the test for any row with:

```bash
npx vitest run --config vitest.config.coverage.ts <name-fragment>
```

| # | Challenge (from the brief) | Solution | TRD | Plan | Primary tests (REQ / scenario) | Run |
|---|---|---|---|---|---|---|
| 1 | "ExampleHR is not the only system that updates HCM … work anniversary or start of the year … refresh of time off balances" | Scheduled **batch reconciliation** discovers external changes (no webhooks); safe drift updates the local total, unsafe drift (HCM < reserved) raises a conflict; **point reconciliation** handles single-balance drift detected on the hot path. | §9.2, §9.3, §9.7 | 04, 06 | REQ-REC-01..06, F-08, R-06 — `reconciliation.service.spec.ts`, `reconciliation.e2e-spec.ts` | `npx vitest run --config vitest.config.coverage.ts reconciliation` |
| 2 | "HCM provides a realtime API for getting or sending time off values" | Approval/cancellation sagas call the realtime `POST /balances/adjust`; reads use the realtime reader. Every write carries an idempotency key `<request_id>:<op>`. | §9.1, §9.2 | 02, 03 | REQ-SYNC-01/02/03 — `hcm-client.contract.spec.ts`, `hcm-reader-client.contract.spec.ts` | `npx vitest run --config vitest.config.coverage.ts hcm-client.contract` |
| 3 | "HCM provides a batch end point that would send the whole corpus of time off balances" | Reconciliation pulls the batch endpoint with `since=<last_run>`, paginated, and reconciles each balance against local state inside an OCC-guarded transaction. | §9.3 | 04 | REQ-REC-01, REQ-REC-04 — `reconciliation.service.spec.ts` (batch path), `reconciliation.repository.spec.ts` | `npx vitest run --config vitest.config.coverage.ts reconciliation.service` |
| 4 | "We can count on HCM to send back errors … HOWEVER this may not be always guaranteed; we want to be defensive about it." | Never trust a 2xx blindly: a mandatory **arithmetic check** (`new_total == pre_total ± delta`) + `hcm_correlation_id` presence on every adjust response; ambiguous responses fail the saga and enqueue point reconciliation; **circuit breaker + retry** for faults; a **stuck-state sweep** resolves requests wedged mid-saga. | §9.4, §9.7, §11 | 02, 03, 06 | REQ-SYNC-03/04, F-01..F-05, REQ-DEF-07/11/12 — `hcm-response-check.spec.ts`, `circuit-breaker.spec.ts`, `stuck-state-sweep.e2e-spec.ts` | `npx vitest run --config vitest.config.coverage.ts hcm-response-check` |

A fifth cross-cutting concern — **concurrent writes preserving balance invariants** (employees, managers, and reconciliation acting on the same row) — is handled by optimistic concurrency with bounded retry and verified by property-based tests over random operation sequences (INV-01..05, R-01..R-06; `invariants.property.spec.ts`, TRD §10).

## See it run — the live showcase

The four challenges (and more) are also a runnable, self-asserting walkthrough:

```bash
npm run demo:scenarios
```

This boots the real service + mock HCM as separate processes, drives them over HTTP, narrates each scenario, and asserts every outcome (non-zero exit on any mismatch). The same run regenerates [`docs/demo/SHOWCASE.md`](docs/demo/SHOWCASE.md) — a GitHub-rendered tour with a **Mermaid sequence diagram of the real calls** per scenario, before/after balance tables, and the four challenges flagged. `npm run ci` includes `demo:check`, which fails the build if that showcase ever drifts from real behavior.

Eight scenarios across three themes: **Lifecycle** (reservation, approval saga, cancellation), **Resilience** (ambiguous-HCM defense), **Consistency** (anniversary reconciliation, batch corpus, concurrency race, idempotent replay). Challenges 1-4 from the brief are each tagged in the showcase.

---

## Architecture at a glance

```
                 HTTP (REST, /api/v1, JWT HS256)
                          │
        ┌─────────────────▼──────────────────┐         realtime adjust / read
        │      time-off-service (NestJS)      │  ───────────────────────────────▶  ┌──────────────┐
        │                                     │         batch corpus (since=)       │     HCM      │
        │  reservation · approval saga ·      │  ───────────────────────────────▶  │ (mock-hcm in │
        │  cancellation saga · reconciliation │         arithmetic-checked 2xx      │  this repo)  │
        │  · circuit breaker · stuck sweep    │  ◀───────────────────────────────  └──────────────┘
        └─────────────────┬──────────────────┘
                          │ TypeORM (migrations, never synchronize)
                 ┌────────▼─────────┐
                 │  SQLite (WAL)    │  requests · balances · audit (append-only)
                 │                  │  idempotency · reconciliations
                 └──────────────────┘
```

- **Reads and submissions** stay local (no HCM call) — instant employee feedback.
- **Approvals and cancellations** cross to HCM through the saga, gated by the circuit breaker and verified arithmetically.
- **Reconciliation and the stuck-state sweep** are scheduler-driven; reconciliation skips while the breaker is OPEN.
- The **mock HCM** ships in this repo (`apps/mock-hcm`) and simulates balance changes (anniversary grants, drift, ambiguous/slow/down scenarios) — per the brief's suggestion to run a real mock server.

---

## Quickstart

Requires Node 20+ and npm.

```bash
# 1. Install
npm install

# 2. Configure environment (every variable is documented in .env.example)
cp .env.example .env
#   At minimum set JWT_SIGNING_KEY, DATABASE_FILE, HCM_BASE_URL (defaults work for local dev).

# 3. Apply database migrations (schema is migration-driven; synchronize is never enabled)
npm run migration:run

# 4. Run — two processes (see note below)
npm run start:mock-hcm      # terminal A: the mock HCM (source-of-truth simulator)
npm run start               # terminal B: the time-off service on http://localhost:3000/api/v1
```

### Two-process note

This is a NestJS monorepo with **two applications**: `time-off-service` (the microservice) and `mock-hcm` (the HCM simulator the service talks to). For local manual exploration, start both. The automated test suite boots the service in-process and uses the mock HCM as an in-process module or a controlled stub — no separate process is needed to run the tests.

---

## Tests and proof of coverage

The brief's explicit deliverable is "your test cases and proof of coverage." One command produces it:

```bash
npm run ci
```

`ci` runs, in order, and exits non-zero on the first failure:

1. **`typecheck`** — `tsc --noEmit` (strict, no `any`).
2. **`lint:check`** — ESLint.
3. **`coverage`** — the full suite (unit, integration, contract, e2e, concurrency, chaos, property-based) in one pass with thresholds enforced (see below).
4. **`verify:traceability`** — proves every requirement maps to a real test and the matrix has no drift.

### Running individual layers

```bash
npm test                    # fast inner loop: unit/integration/contract/chaos/property (*.spec.ts)
npm run test:e2e            # end-to-end HTTP suite only (*.e2e-spec.ts)
npm run coverage            # every layer + coverage report (HTML + LCOV in ./coverage)
npm run verify:traceability # requirement ↔ test ↔ matrix consistency check
npx vitest run --config vitest.config.coverage.ts <name>   # any single spec by name fragment
```

The HTML coverage report is written to `coverage/index.html`.

### Coverage thresholds

Two axes (TRD §12, `docs/trd/test-strategy.md` §3): **scenario coverage** is the lead indicator (every state transition, race, failure mode, and invariant has a test — see `docs/trd/traceability.md`); **line coverage** is the lagging one. Enforced floors:

- **≥ 85% line coverage overall** (currently ~88%).
- **Per-file floors on the critical services** (reservation, approval saga, cancellation saga, reconciliation, circuit breaker). These sit at their achievable level; the remaining uncovered lines are documented defensive guards and explicitly-unreachable safety branches, not gaps in scenario coverage.

### The traceability verifier

`scripts/verify-traceability.ts` parses the `@req REQ-XXX-NN` JSDoc tags on test `describe` blocks, the requirement headings in `docs/trd/requirements.md`, and the matrix in `docs/trd/traceability.md`, then fails the build on any of: an annotation referencing an unknown requirement, a requirement with no covering test, a matrix row pointing at a non-existent test, or requirement/matrix drift. Its own behavior is covered by meta-tests in `scripts/verify-traceability.spec.ts`. The contract is documented in `docs/trd/test-strategy.md` §4.

---

## Project layout

```
apps/
  time-off-service/   the microservice (modules: auth, balances, time-off, hcm-sync, reconciliation, health)
  mock-hcm/           the HCM simulator (scenario control plane: normal, slow, flaky, ambiguous, down)
scripts/
  verify-traceability.ts    the CI traceability verifier
docs/
  TRD.md              design narrative (source of truth)
  plan/               the eight implementation cycles
  trd/                requirements.md, api-contract.md, test-strategy.md, traceability.md, mock-hcm.md, adr/
```

## Stack

NestJS 11 · TypeScript (strict) · TypeORM with checked-in migrations (`synchronize` never enabled) · better-sqlite3 (WAL) · Vitest + supertest + fast-check · class-validator · pino · jsonwebtoken (HS256) · `@nestjs/throttler` · Joi-validated env at boot.

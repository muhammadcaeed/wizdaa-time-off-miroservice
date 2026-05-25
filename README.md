# Time-Off Service

A backend microservice that coordinates employee time-off against an external **HCM** (Human Capital Management) system. The CRUD is easy. The HCM is what makes this hard: it's the source of truth, it has **multiple writers nobody here controls** (anniversary grants, year-start refreshes, manual HR edits), it pushes **no change notifications**, and it can't be trusted to report its own errors. So this service mirrors HCM state defensively. Pending requests reserve balance locally, so employees get instant feedback. Every balance-changing write goes through a saga with an arithmetic-verified HCM round-trip. A circuit breaker and bounded retry absorb HCM faults. Scheduled reconciliation catches whatever changed outside the service.

Three things it sets out to demonstrate:

- **Design under uncertainty.** A documented decision trail (a [TRD](docs/TRD.md) plus twelve [ADRs](docs/trd/adr/README.md)) that shows *why* each tradeoff was made.
- **Defensive integration.** Idempotent writes, a `2xx` that gets arithmetically verified before it's believed, drift detection, and automatic recovery from mid-saga crashes.
- **Verified correctness.** Five balance invariants checked under random concurrent operation sequences, plus a CI gate that fails the build the moment any requirement loses its covering test.

> **Fastest way to judge this project:** run `npm run demo:scenarios` (see [below](#see-it-run)). It boots the real service against a mock HCM, drives eight scenarios over HTTP, asserts every outcome, then regenerates a narrated, diagrammed walkthrough at [`docs/demo/SHOWCASE.md`](docs/demo/SHOWCASE.md).

---

## Contents

- [Quickstart](#quickstart)
- [See it run](#see-it-run)
- [Architecture at a glance](#architecture-at-a-glance)
- [How it stays consistent](#how-it-stays-consistent)
- [Tests and proof of coverage](#tests-and-proof-of-coverage)
- [Project layout](#project-layout)
- [Stack](#stack)
- [Documentation](#documentation)

---

## Quickstart

Requires **Node 20+** and npm. From a fresh clone, one command does everything. It installs dependencies, writes a `.env` from the documented template (it won't clobber an existing one), creates the local data directory, and applies migrations:

```bash
npm run setup
```

Then run the two processes (see the note below):

```bash
npm run start:mock-hcm   # terminal A: the mock HCM (source-of-truth simulator)
npm run start            # terminal B: the service on http://localhost:3000/api/v1
```

Or skip straight to the self-asserting tour: `npm run demo:scenarios`.

**Why two processes?** This is a NestJS monorepo with two applications: `time-off-service` (the microservice) and `mock-hcm` (the external HCM, simulated). For manual exploration, start both. The automated test suite boots the service in-process and uses the mock HCM either as an in-process module or a controlled out-of-process stub, so you don't need to start anything by hand to run the tests or the demo.

<details>
<summary><strong>Manual installation</strong> (the steps <code>npm run setup</code> performs)</summary>

```bash
# 1. Install
npm install

# 2. Configure environment (every variable is documented in .env.example).
#    Boot fails fast if a required var is missing. Defaults work for local dev.
cp .env.example .env          # Windows: copy .env.example .env

# 3. Create the local data directory and apply migrations
#    (schema is migration-driven; TypeORM synchronize is never enabled).
mkdir -p data                 # Windows: mkdir data
npm run migration:run
```

`npm run setup` does the same thing through a cross-platform Node script, so it works the same on Windows, macOS, and Linux.

</details>

---

## See it run

The system runs as a self-asserting walkthrough:

```bash
npm run demo:scenarios
```

This boots the real service and the mock HCM as **separate processes**, drives them over HTTP, narrates each step, and asserts every outcome (non-zero exit on any mismatch). The same run regenerates [`docs/demo/SHOWCASE.md`](docs/demo/SHOWCASE.md), a GitHub-rendered tour with a **Mermaid sequence diagram of the actual calls** per scenario, before/after balance tables, and the invariant each step protects.

Eight scenarios across three themes:

| Theme | Scenarios |
|---|---|
| **Lifecycle** | instant reservation (no HCM call), approval saga with arithmetic-verified commit, cancellation reverse saga |
| **Resilience** | ambiguous HCM "success" treated as a failure |
| **Consistency** | external-writer reconciliation (safe vs. unsafe drift), batch-corpus reconciliation, concurrent submissions that can't oversell a balance, idempotent retry that reserves exactly once |

`npm run ci` includes `demo:check`, which fails the build if the committed showcase ever drifts from real behavior, so the document can't lie.

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

- **Reads and submissions** stay local (no HCM call), so employees get instant, definitive feedback even when the HCM is down.
- **Approvals and cancellations** cross to the HCM through a saga: a single HCM write bracketed by two local transactions, gated by the circuit breaker and verified arithmetically.
- **Reconciliation and the stuck-state sweep** run on the scheduler. Reconciliation skips its run while the breaker is OPEN instead of retrying blindly.
- The **mock HCM** ships in this repo (`apps/mock-hcm`) and simulates real-world misbehavior on demand (slow, flaky, ambiguous, down), so the defensive paths run against a live server.

The full design narrative lives in [`docs/TRD.md`](docs/TRD.md): flows, domain model, state machine, failure catalog, and the alternatives weighed at each turn.

---

## How it stays consistent

Local state and HCM state can disagree at any moment, yet the service never corrupts a balance. Four mechanisms carry that load:

- **Reservation model.** A balance carries two counters: `total_days` (HCM-authoritative) and `reserved_days` (local in-flight commitments). Available is `total − reserved`. A pending request reserves locally and touches the HCM only at approval, so a rejected request costs nothing and a fresh HCM total slots in without disturbing in-flight requests.
- **Verified HCM writes.** Every HCM write carries a deterministic idempotency key and a mandatory arithmetic check. The service commits only when `new_total == pre_total ± delta` *and* a correlation id is present. Anything ambiguous (mismatch, timeout, dropped connection) routes to a failure state and enqueues a targeted point reconciliation.
- **Optimistic concurrency.** Every balance write is a version-checked CAS, and every status change is a status-predicate CAS. Contending writers (employee, manager, reconciliation job) serialize correctly: one wins, the others re-read or get a 409. Property-based tests cover this over random operation sequences.
- **Self-healing.** A circuit breaker fast-fails writes during an HCM outage while reads keep serving. A stuck-state sweep finds requests wedged mid-saga (say, after a process crash), replays the HCM call with the original key, and resolves them automatically.

Depth, pseudocode, and the race-scenario catalog live in the TRD: [§9 HCM integration](docs/TRD.md#9-hcm-integration-and-sync-design), [§10 Concurrency](docs/TRD.md#10-concurrency-consistency-and-the-reservation-pattern), [§11 Failure handling](docs/TRD.md#11-failure-modes-recovery-and-defensive-behaviors).

---

## Tests and proof of coverage

One command runs the full gate, exiting non-zero on the first failure:

```bash
npm run ci
```

The gate runs five stages in order, stopping at the first red:

| Stage | What it enforces |
|---|---|
| `typecheck` | `tsc --noEmit`, strict mode, no `any` |
| `lint:check` | ESLint, no warnings |
| `coverage` | full suite in one pass, coverage thresholds enforced |
| `verify:traceability` | every requirement maps to a real test; no matrix drift |
| `demo:check` | committed showcase still matches live behavior |

**Seven test layers** carry the suite, fast ones first:

| Layer | Verifies | Tooling |
|---|---|---|
| Unit | pure logic in isolation | Vitest |
| Integration | service + real SQLite, no external HTTP | Vitest + `@nestjs/testing` |
| Contract | HCM client honors the assumed contract | in-process mock HCM |
| End-to-end | full HTTP through the service | supertest + out-of-process mock HCM |
| Concurrency | invariants under real parallelism | `Promise.all` against a running service |
| Chaos | failure injection (timeouts, ambiguity, outage, breaker transitions) | mock HCM scenario control plane |
| Property-based | five invariants under random operation sequences | `fast-check` |

**Coverage floors are enforced in CI.** Scenario coverage drives quality here: every state transition, race, failure mode, and invariant has a test. Line floors back that up:

| Scope | Floor |
|---|---|
| Overall | ≥ 85% lines |
| Circuit breaker | ≥ 98% lines |
| Approval saga | ≥ 95% lines |
| Reservation service | ≥ 95% lines |
| Cancellation saga | ≥ 90% lines |
| Reconciliation service | ≥ 86% lines |

The HTML report lands in `coverage/index.html`.

**The traceability verifier is worth a second look.** `scripts/verify-traceability.ts` parses the `@req REQ-XXX-NN` JSDoc tags on test `describe` blocks, the requirement headings in [`docs/trd/requirements.md`](docs/trd/requirements.md), and the matrix in [`docs/trd/traceability.md`](docs/trd/traceability.md), then fails the build on *any* drift: an annotation citing an unknown requirement, a requirement with no covering test, or a matrix row pointing at a test that doesn't exist. Meta-tests cover the verifier itself.

```bash
npm test                    # fast inner loop (unit/integration/contract/chaos/property)
npm run test:e2e            # end-to-end HTTP suite only
npm run coverage            # every layer + HTML/LCOV report in ./coverage
npm run verify:traceability # requirement ↔ test ↔ matrix consistency check
```

---

## Project layout

```
apps/
  time-off-service/   the microservice (modules: auth, balances, time-off, hcm-sync, reconciliation, health)
  mock-hcm/           the HCM simulator (scenario control plane: normal, slow, flaky, ambiguous, down)
scripts/
  verify-traceability.ts    the CI traceability verifier
  demo-scenarios.ts         the live, self-asserting showcase runner
docs/
  TRD.md              design narrative (source of truth)
  demo/SHOWCASE.md    generated walkthrough of a real run
  trd/                requirements.md, data-model.md, api-contract.md, concurrency.md, hcm-integration.md,
                      failure-handling.md, test-strategy.md, traceability.md, mock-hcm.md, adr/
```

---

## Stack

NestJS 11 · TypeScript (strict) · TypeORM with checked-in migrations (`synchronize` never enabled) · better-sqlite3 (WAL) · Vitest + supertest + fast-check · class-validator · pino · jsonwebtoken (HS256) · `@nestjs/throttler` · Joi-validated env at boot.

---

## Documentation

The **[TRD](docs/TRD.md)** (Technical Requirements Document) is the source of truth and the place to start. It carries the design narrative: context, personas and flows, the domain model and its invariants, the request-lifecycle state machine, HCM integration, concurrency, failure handling, security, and the technology rationale. It's written for three audiences (reviewers evaluating judgment, engineers implementing, and AI agents generating code against it), and it opens with three reading paths, so you can spend 5 minutes or an hour as you like.

Around the TRD sit **companion files** (implementer-level reference detail) and **twelve ADRs** (one per decision, with the alternatives weighed). The TRD's document map cross-links each section to its companion and governing ADRs.

| Document | What's in it |
|---|---|
| **[TRD.md](docs/TRD.md)** | the design narrative; source of truth, with reading paths and a section/companion/ADR map |
| [trd/adr/](docs/trd/adr/README.md) | twelve Architecture Decision Records (Nygard format), each with the alternatives considered |
| [trd/requirements.md](docs/trd/requirements.md) | functional + non-functional requirements in EARS notation, each with a stable ID |
| [trd/data-model.md](docs/trd/data-model.md) | entity field specs, indexes, constraints, per-entity notes |
| [trd/api-contract.md](docs/trd/api-contract.md) | endpoints, RBAC matrix, RFC 7807 errors, idempotency, pagination, async polling |
| [trd/hcm-integration.md](docs/trd/hcm-integration.md) | HCM contract shapes, reconciliation + point-reconciliation pseudocode, multi-writer detail |
| [trd/concurrency.md](docs/trd/concurrency.md) | OCC protocol, transaction-boundary tables, SQLite-vs-Postgres test-realism notes |
| [trd/failure-handling.md](docs/trd/failure-handling.md) | failure catalog detail, circuit-breaker + retry config, stuck-state sweep |
| [trd/test-strategy.md](docs/trd/test-strategy.md) | the seven layers, coverage approach, traceability-verifier contract |
| [trd/traceability.md](docs/trd/traceability.md) | every requirement, invariant, race, and failure mode mapped to its test; CI-enforced |
| [trd/mock-hcm.md](docs/trd/mock-hcm.md) | mock HCM spec and its scenario control plane |
| [demo/SHOWCASE.md](docs/demo/SHOWCASE.md) | generated, diagrammed walkthrough of a real `demo:scenarios` run |

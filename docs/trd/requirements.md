# Requirements

Companion to `TRD.md`. Functional requirements use **EARS notation** (Easy Approach to Requirements Syntax) with stable IDs that the test suite traces against (see `traceability.md`). Non-functional requirements follow as a tabular reference.

EARS patterns:

- **Ubiquitous**: a constant requirement (`The system shall ...`)
- **Event-driven**: triggered by an event (`When ... the system shall ...`)
- **State-driven**: active during a state (`While ... the system shall ...`)
- **Unwanted-behavior**: defensive (`If ... then the system shall ...`)

Invariants `INV-01` through `INV-05` are defined in TRD §4.2 and verified by property-based testing (see `test-strategy.md` §5).

> **ID supersession (plan 08).** As the cross-cutting concerns were built out (plans 04-07), four umbrella `REQ-DEF-*` IDs were split into dedicated families for one-ID-per-behavior traceability. `REQ-DEF-02/03/04` (client idempotency) are superseded by `REQ-IDEM-01..05` (§1.7); `REQ-DEF-09` (PII redaction) is superseded by `REQ-PII-01` and `REQ-LOG-01` (§1.8). The superseded IDs are retired here so the CI verifier maps one requirement to one behavior. `REQ-DEF-01` is retained as the invariants umbrella.

---

## 1. Functional requirements

### 1.1 Balance read (REQ-BAL-*)

**REQ-BAL-01** (Event-driven): When an Employee invokes `GET /api/v1/balances/employees/:employee_id` for their own `employee_id`, the system shall return a list of balances (one per location) with computed `available_days = total_days - reserved_days`.

**REQ-BAL-02** (Event-driven): When a Manager invokes the balance endpoint for an employee whose `manager_id` matches the actor's id, the system shall return the same balance response as REQ-BAL-01.

**REQ-BAL-03** (Unwanted behavior): If an actor invokes the balance endpoint for an employee outside their authorized scope, then the system shall return 403 with `/errors/forbidden` without revealing whether the employee exists.

**REQ-BAL-04** (Ubiquitous): The balance read endpoint shall serve from local cache without calling HCM.

**REQ-BAL-05** (Ubiquitous): Every balance response shall include `last_hcm_sync_at` so the caller can reason about cache freshness.

### 1.2 Request lifecycle (REQ-LIFE-*)

**REQ-LIFE-01** (Event-driven): When an Employee submits a TimeOffRequest and `available_days >= days_requested`, the system shall create the request in SUBMITTED state and increment `Balance.reserved_days` by `days_requested` in a single atomic transaction.

**REQ-LIFE-02** (Unwanted behavior): If an Employee submits a TimeOffRequest with `days_requested > available_days`, then the system shall reject the request with 409 `/errors/insufficient-balance` and shall not modify any state.

**REQ-LIFE-03** (Event-driven): When a Manager invokes the approval endpoint for a request in SUBMITTED whose owner's `manager_id` matches the actor's id, the system shall transition the request to APPROVING, initiate the HCM decrement with idempotency key `<request_id>:decrement`, and emit an audit entry tagged `request.approving`.

**REQ-LIFE-04** (Event-driven): When the HCM decrement for a request in APPROVING returns 2xx with `new_total_days == pre_total - days_requested` and a non-empty `hcm_correlation_id`, the system shall transition the request to APPROVED, decrement `Balance.total_days` by `days_requested`, decrement `Balance.reserved_days` by `days_requested`, store the `hcm_correlation_id`, and emit `request.approved`, all in a single atomic transaction.

**REQ-LIFE-05** (Unwanted behavior): If the HCM decrement for a request in APPROVING fails, times out, or returns an ambiguous response, then the system shall transition the request to APPROVAL_FAILED, release the reservation by decrementing `Balance.reserved_days`, populate `failure_reason`, and emit `request.approval_failed`.

**REQ-LIFE-06** (Event-driven): When an Admin invokes `POST /requests/:id/approval-retries` for a request in APPROVAL_FAILED, the system shall first re-validate that `available_days >= days_requested` against the current `Balance` row. If validation passes, the system shall transition the request back to APPROVING, re-acquire the reservation by incrementing `Balance.reserved_days`, and re-initiate the HCM decrement with the original idempotency key. If validation fails (drift has eroded available days since the original attempt), the system shall return 409 `/errors/insufficient-balance` and the request shall remain in APPROVAL_FAILED.

**REQ-LIFE-07** (Event-driven): When a Manager invokes the reject endpoint for a request in SUBMITTED, the system shall transition the request to REJECTED and decrement `Balance.reserved_days`.

**REQ-LIFE-08** (Event-driven): When the request owner invokes the cancel endpoint for a request in SUBMITTED, the system shall transition the request to CANCELLED and decrement `Balance.reserved_days`.

**REQ-LIFE-09** (Event-driven): When the request owner invokes the cancel endpoint for a request in APPROVED with `start_date > today`, the system shall transition the request to CANCELLING and initiate the HCM increment with idempotency key `<request_id>:increment`.

**REQ-LIFE-10** (Event-driven): When the HCM increment for a request in CANCELLING returns 2xx with `new_total_days == pre_total + days_requested` and a non-empty `hcm_correlation_id`, the system shall transition the request to CANCELLED, increment `Balance.total_days` by `days_requested`, store the increment's `hcm_correlation_id`, and emit `request.cancelled`.

**REQ-LIFE-11** (Unwanted behavior): If the HCM increment for a request in CANCELLING fails, times out, or returns an ambiguous response, then the system shall transition the request to CANCELLATION_FAILED and populate `failure_reason`.

**REQ-LIFE-12** (Event-driven): When an Admin invokes `POST /requests/:id/cancellation-retries` for a request in CANCELLATION_FAILED, the system shall transition the request to CANCELLING and re-initiate the HCM increment with the original idempotency key.

**REQ-LIFE-13** (Event-driven): When the request owner or an Admin invokes the cancel endpoint for a request in APPROVAL_FAILED, the system shall transition the request to CANCELLED without an HCM call.

**REQ-LIFE-14** (Unwanted behavior): If the cancel endpoint is invoked on a request in APPROVING or CANCELLING, then the system shall return 409 `/errors/invalid-state-transition`.

**REQ-LIFE-15** (Unwanted behavior): If a Manager invokes the approval endpoint for a request whose owner is not their direct report, then the system shall return 403 without modifying state.

**REQ-LIFE-16** (Unwanted behavior): If a Manager invokes the approval endpoint for a request not in SUBMITTED, then the system shall return 409 `/errors/invalid-state-transition`.

### 1.3 HCM sync (REQ-SYNC-*)

**REQ-SYNC-01** (Ubiquitous): The system shall use the realtime HCM `POST /balances/adjust` for the approval and cancellation sagas.

**REQ-SYNC-02** (Ubiquitous): Every HCM write shall carry an `Idempotency-Key` header constructed as `<request_id>:<operation_type>`.

**REQ-SYNC-03** (Event-driven): When an HCM write returns 2xx, the system shall verify that the response carries a non-empty `hcm_correlation_id` and that `new_total_days == pre_total + delta` (where `pre_total` is the local total captured before the call and `delta` is the signed adjustment) before treating the operation as committed.

**REQ-SYNC-04** (Unwanted behavior): If the adjust response's `new_total_days` disagrees with `pre_total + delta`, or if the response is missing a `hcm_correlation_id`, then the system shall treat the operation as ambiguous failure (F-04) and shall enqueue a point reconciliation (TRD §9.3) for the affected `(employee, location)`.

**REQ-SYNC-04a** (Event-driven): After a successful HCM-bound saga commits, the system shall asynchronously perform a `GET /hcm/balances/:employee_id` and shall emit `hcm.<op>.drift_detected` plus enqueue a point reconciliation if the verified total disagrees with the local total. This check shall not roll back the committed transition.

**REQ-SYNC-05** (Ubiquitous): Every HCM interaction (request and response) shall produce an AuditLog entry with action `hcm.<operation>.<outcome>`, including request body, response body, duration, and HCM correlation_id.

**REQ-SYNC-06** (State-driven): While the HCM circuit breaker is in OPEN state, the system shall fast-fail HCM calls with `/errors/hcm-unavailable` (503) and shall not perform retries.

**REQ-SYNC-07** (Event-driven): When an HCM call fails with a retryable error (F-01, F-02, F-03), the system shall retry per the policy in TRD §11.3 using the original idempotency key.

**REQ-SYNC-08** (Unwanted behavior): If HCM returns 4xx `insufficient_balance` after local validation passed, then the system shall not retry, shall fail the operation, and shall enqueue a targeted point reconciliation (TRD §9.3) for the affected `(employee, location)`. A full batch reconciliation shall not be triggered for single-balance drift events.

### 1.4 Reconciliation (REQ-REC-*)

**REQ-REC-01** (Event-driven): When the reconciliation scheduler fires, or an Admin invokes `POST /api/v1/reconciliations`, the system shall create a Reconciliation resource in `RUNNING` state and pull the HCM batch endpoint with `since=<last_successful_run_at>`.

**REQ-REC-02** (Event-driven): When the reconciliation algorithm observes `hcm_total_days != local.total_days` and `hcm_total_days - reserved_days >= 0`, the system shall update `local.total_days` to match HCM, increment the version, set `last_hcm_sync_at`, and emit `balance.reconciled`.

**REQ-REC-03** (Unwanted behavior): If the reconciliation algorithm observes `hcm_total_days < reserved_days` for a balance, then the system shall not update the balance, shall emit `balance.reconciliation.conflict` with metadata, and shall increment the run's conflict counter.

**REQ-REC-04** (Event-driven): When a reconciliation run completes, the system shall set the run's status to `COMPLETED` (zero conflicts) or `COMPLETED_WITH_CONFLICTS`, set `completed_at`, and persist the conflict count.

**REQ-REC-05** (Ubiquitous): A reconciliation run shall be idempotent: re-running with the same `since` timestamp produces equivalent state.

**REQ-REC-06** (Unwanted behavior): If a reconciliation run is requested while another run is in `RUNNING` state, then the system shall return 409 `/errors/reconciliation-in-progress`.

### 1.5 Defensive behaviors (REQ-DEF-*)

**REQ-DEF-01** (Ubiquitous): The system shall maintain invariants INV-01 through INV-05 (TRD §4.2) under all observed conditions, including concurrent writes and partial failures.

*(REQ-DEF-02, REQ-DEF-03, REQ-DEF-04 superseded by REQ-IDEM-01..05 — see §1.7.)*

**REQ-DEF-05** (Ubiquitous): Every state transition shall produce an AuditLog entry in the same database transaction as the state change.

**REQ-DEF-06** (Ubiquitous): The audit repository shall expose `insert` only; no method shall update or delete AuditLog rows.

**REQ-DEF-07** (Event-driven): When the HCM is unreachable for an approval or cancellation saga, the system shall transition the affected request to APPROVAL_FAILED or CANCELLATION_FAILED rather than leave it in a transient state.

**REQ-DEF-08** (Unwanted behavior): If the optimistic concurrency check on a Balance write fails, then the system shall retry the operation up to 3 times before returning 409 `/errors/conflict`.

*(REQ-DEF-09 superseded by REQ-PII-01 and REQ-LOG-01 — see §1.8.)*

**REQ-DEF-10** (Ubiquitous): Authorization checks shall load the target resource before evaluating permissions and shall return 403 (without distinguishing missing from forbidden) when the actor is not permitted.

**REQ-DEF-11** (Event-driven): When the stuck-state sweep scheduler fires, the system shall identify TimeOffRequest rows in APPROVING or CANCELLING whose `updated_at` is older than `STUCK_STATE_THRESHOLD_MS` and shall resolve each by calling HCM with the row's original idempotency key, transitioning the request based on the HCM response per TRD §11.4.

**REQ-DEF-12** (Unwanted behavior): If the HCM circuit breaker is OPEN when the stuck-state sweep runs, then the system shall skip the sweep cycle and shall not advance any stuck row, leaving them for the next cycle once the circuit returns to CLOSED or HALF_OPEN.

### 1.6 API error contract (REQ-ERR-*)

The full error envelope and the domain `type` URI catalogue live in `api-contract.md` §4.

**REQ-ERR-01** (Ubiquitous): Every error response shall use the RFC 7807 Problem Details shape (`type`, `title`, `status`, `detail`, `instance`).

**REQ-ERR-02** (Ubiquitous): Every error response shall carry `Content-Type: application/problem+json`.

**REQ-ERR-03** (Event-driven): When request validation fails, the system shall return 400 `/errors/validation` with an `errors` array of field-level `{ field, message }` details.

**REQ-ERR-04** (Ubiquitous): Each error shall carry a stable, documented `type` URI drawn from the catalogue in `api-contract.md` §4 (e.g. `/errors/validation-error`, `/errors/rate-limited`).

**REQ-ERR-05** (Event-driven): When the active request carries a correlation id, the system shall include it as a `correlation_id` extension on the error envelope; unmapped framework exceptions shall fall back to a generic Problem Details envelope rather than leak a stack trace.

### 1.7 Client idempotency (REQ-IDEM-*)

Supersedes REQ-DEF-02/03/04. Semantics defined in `api-contract.md` §6.

**REQ-IDEM-01** (Ubiquitous): All write endpoints (POST) shall require an `Idempotency-Key` (client-generated UUID v4) request header.

**REQ-IDEM-02** (Unwanted behavior): If a write endpoint is invoked with a missing or malformed `Idempotency-Key`, then the system shall return 400 with a hint explaining the requirement.

**REQ-IDEM-03** (Event-driven): When an `Idempotency-Key` is presented that matches a previously-completed request with the same request hash, the system shall return the stored response without re-executing the operation.

**REQ-IDEM-04** (Unwanted behavior): If the same `Idempotency-Key` is presented with a different request hash within the retention window, then the system shall return 422 `/errors/idempotency-conflict`.

**REQ-IDEM-05** (Ubiquitous): The idempotency record shall be written in the same database transaction as the operation outcome, retained for `IDEMPOTENCY_TTL_HOURS`, and pruned by a periodic cleanup job once expired.

### 1.8 Observability & privacy (REQ-LOG-*, REQ-PII-*)

Supersedes REQ-DEF-09.

**REQ-LOG-01** (Ubiquitous): The system shall propagate a correlation id end-to-end: echo a supplied `X-Correlation-ID` verbatim, generate a UUID v4 when absent, and emit it on every response (including error responses).

**REQ-PII-01** (Ubiquitous): The system shall redact employee PII (`email`, `firstName`, `lastName`) from pino log output via fast-redact paths, while retaining full identifying data in the AuditLog table.

### 1.9 Availability surface (REQ-HEALTH-*, REQ-RATE-*)

**REQ-HEALTH-01** (Event-driven): When `GET /api/v1/health` is invoked without authentication, the system shall return 200 with `healthy` when the DB is up and the HCM circuit is CLOSED/HALF_OPEN, `degraded` when the circuit is OPEN, and `unhealthy` when the DB is down (TRD §14.2).

**REQ-RATE-01** (Unwanted behavior): If a client exceeds the configured throttle limit (per-IP and per-authenticated-subject), then the system shall return 429 with the `/errors/rate-limited` Problem Details envelope, without breaking the upstream auth gate.

### 1.10 Request listing (REQ-LIST-*)

**REQ-LIST-01** (Event-driven): When an actor invokes `GET /api/v1/requests` or `GET /api/v1/requests/:id`, the system shall return role-scoped results (employees see only their own; managers/admins see all), paginate via opaque keyset cursor (`api-contract.md` §5), support a `status` filter, hide existence with 403 for out-of-scope reads, and reject malformed cursors/limits with 400.

---

## 2. Non-functional requirements

Targets and behaviors that don't fit cleanly into EARS notation. Each is measurable and traces to a class of test or operational concern.

### 2.1 Performance

Latency targets, measured at the service edge (HTTP response time):

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Balance read (cached) | < 20ms | < 50ms | < 100ms |
| Request submission | < 50ms | < 100ms | < 200ms |
| Approval / cancellation (HCM round-trip) | < 200ms | < 500ms | < 1s |
| List requests (paginated, 50 per page) | < 50ms | < 150ms | < 300ms |
| Reconciliation run (per balance) | < 50ms | < 100ms | < 200ms |

These are targets, not contracts. The mock HCM scenarios let the test suite validate the local component of these latencies. Production targets depend on real HCM latency and are calibrated post-deployment.

Throughput is not a tight constraint at the service-instance level. The design uses optimistic concurrency per `(employee, location)` row, so contention is per-key and the global throughput ceiling is high enough that horizontal scaling matters only at organization scale (thousands of employees).

### 2.2 Availability

The service degrades gracefully rather than blocks under HCM unavailability.

- **Read path** remains available whenever the service and the local database are reachable. Balance reads never call HCM.
- **Write path** fails fast when the HCM circuit breaker is OPEN. Submissions still succeed (they don't call HCM), but approvals, cancellations of approved requests, and saga retries return 503 `/errors/hcm-unavailable`.
- **Reconciliation** skips its scheduled run when HCM is unreachable. The next interval retries.

The service has no internal availability SLA; it is bounded by the availability of the HCM and the local database. The design's contribution is to prevent HCM failures from cascading into local data corruption.

### 2.3 Durability

- **Audit log** is retained indefinitely. There is no purge policy in scope. A retention policy is noted as future work in TRD §13.4.
- **Local state recovery** is supported via audit replay. The audit log is a complete record of state transitions; a recovery script can reconstruct `TimeOffRequest` and `Balance` rows from the audit alone, then call HCM to validate `total_days`.
- **Total local DB loss** is recoverable. Reconciliation pulls the full HCM corpus; the audit log can be replayed against it (or, in catastrophic cases, lost) and the service resumes with HCM as the source of truth and an empty reservation set.
- **Migrations** are explicit. TypeORM migrations are committed to the repository and applied in order. `synchronize: true` is never enabled, in any environment.

### 2.4 Scalability

- Single-instance deployment is assumed for this scope. The service ships as one Node process with one SQLite file.
- **Horizontal scaling** is supported when the storage layer is migrated to PostgreSQL. The optimistic concurrency pattern works unchanged on Postgres; advisory locks become available for high-contention keys; native ENUM and JSON-with-GIN-indexes are options for the audit log.
- **Configuration** is env-driven. Connection pool sizes, HCM client timeouts, circuit breaker thresholds, reconciliation cadence, throttle limits, and JWT secret are all set via environment variables. The README documents the full list.

Scalability beyond a single Postgres-backed instance (e.g., sharded by tenant) is out of scope and outside the service's design surface. The reservation pattern and the saga design have no inherent ceiling that would prevent such a migration.

---

## 3. Traceability summary

The full requirement-to-test mapping lives in `traceability.md`. At a glance, each requirement ID below maps to at least one test case, verified in CI:

| Category | IDs | Coverage notes |
|---|---|---|
| Balance read | REQ-BAL-01..05 | Integration tests, e2e auth tests |
| Lifecycle | REQ-LIFE-01..16 | Integration + e2e per transition; chaos for failure paths |
| HCM sync | REQ-SYNC-01..08, 04a | Contract tests + chaos for defensive behaviors |
| Reconciliation | REQ-REC-01..06 | Integration + e2e + property-based |
| Defensive | REQ-DEF-01, 05..08, 10..12 | Spread across all layers; INV-01..05 verified by property-based |
| API error contract | REQ-ERR-01..05 | Unit (exception filter) + e2e |
| Client idempotency | REQ-IDEM-01..05 | Unit (service) + e2e |
| Observability & privacy | REQ-LOG-01, REQ-PII-01 | Unit (middleware/redact config) + e2e |
| Availability surface | REQ-HEALTH-01, REQ-RATE-01 | Unit (health service) + e2e |
| Request listing | REQ-LIST-01 | Unit (repository) + e2e |

The CI verifier parses requirement IDs from test annotations (a `@req` JSDoc tag on each `describe` block) and matches them against `traceability.md`. Any REQ or INV without a covering test fails the build.

# Traceability Matrix

Companion to `requirements.md` and `test-strategy.md`. Every `REQ-*` and `INV-*` maps to one or more test cases. The CI verifier (`scripts/verify-traceability.ts`, see `test-strategy.md` §4) fails the build if any requirement lacks a covering test, any test annotation references an unknown ID, or any row below references a test file or name that no longer exists.

This file is the single source of truth for coverage; treat it as code, not documentation. PRs that change requirements must update this matrix.

**Layout note.** Tests are co-located with the code they exercise: unit/integration/contract/chaos/property specs are `*.spec.ts` next to their module; end-to-end specs live under `apps/time-off-service/test/*.e2e-spec.ts`. Paths below are repo-relative and resolved literally by the verifier. The "Test" column names the `describe` block; the listed file may contain several `it` cases under it.

---

## 1. Balance read (REQ-BAL-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-BAL-01 | Employee reads own balance with computed available_days | `apps/time-off-service/test/balance-read.e2e-spec.ts` | GET /api/v1/balances/employees/:employee_id (e2e) |
| REQ-BAL-02 | Manager reads direct report balance | `apps/time-off-service/test/balance-read.e2e-spec.ts` | GET /api/v1/balances/employees/:employee_id (e2e) |
| REQ-BAL-03 | Out-of-scope read returns 403 without enumeration | `apps/time-off-service/src/modules/auth/authorization.service.spec.ts` | AuthorizationService (RBAC, 403 hides existence) |
| REQ-BAL-04 | Balance read serves from cache without HCM call | `apps/time-off-service/test/balance-read.e2e-spec.ts` | GET /api/v1/balances/employees/:employee_id (e2e) |
| REQ-BAL-05 | Response includes last_hcm_sync_at | `apps/time-off-service/test/balance-read.e2e-spec.ts` | GET /api/v1/balances/employees/:employee_id (e2e) |

## 2. Request lifecycle (REQ-LIFE-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-LIFE-01 | Submit creates SUBMITTED + reserves | `apps/time-off-service/src/modules/time-off/request.service.spec.ts` | RequestService.submit (T-01 reservation) |
| REQ-LIFE-02 | Submit rejects when insufficient balance | `apps/time-off-service/src/modules/time-off/request.service.spec.ts` | RequestService.submit (T-01 reservation) |
| REQ-LIFE-03 | Manager approve transitions to APPROVING + initiates HCM decrement | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| REQ-LIFE-04 | HCM-confirmed approval commits balance | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| REQ-LIFE-05 | HCM failure / ambiguity moves to APPROVAL_FAILED and releases reservation | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| REQ-LIFE-06 | Admin retry re-validates available balance, uses original key | `apps/time-off-service/test/retry.e2e-spec.ts` | Admin retry endpoints (e2e) |
| REQ-LIFE-07 | Reject releases reservation | `apps/time-off-service/src/modules/time-off/reject.service.spec.ts` | RequestService.reject (T-07) |
| REQ-LIFE-08 | Cancel pre-approval releases reservation | `apps/time-off-service/src/modules/time-off/cancel.service.spec.ts` | RequestService.cancel (router T-06/08/09, ADR-012) |
| REQ-LIFE-09 | Cancel approved future-dated triggers saga | `apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service.spec.ts` | CancellationSagaService (reverse saga T-09/10/11) |
| REQ-LIFE-10 | HCM-confirmed cancellation commits | `apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service.spec.ts` | CancellationSagaService (reverse saga T-09/10/11) |
| REQ-LIFE-11 | HCM failure on cancellation moves to CANCELLATION_FAILED | `apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service.spec.ts` | CancellationSagaService (reverse saga T-09/10/11) |
| REQ-LIFE-12 | Admin retry of failed cancellation | `apps/time-off-service/test/retry.e2e-spec.ts` | Admin retry endpoints (e2e) |
| REQ-LIFE-13 | Cancel of APPROVAL_FAILED skips HCM | `apps/time-off-service/src/modules/time-off/cancel.service.spec.ts` | RequestService.cancel (router T-06/08/09, ADR-012) |
| REQ-LIFE-14 | Cancel during saga returns 409 | `apps/time-off-service/src/modules/time-off/cancel.service.spec.ts` | RequestService.cancel (router T-06/08/09, ADR-012) |
| REQ-LIFE-15 | Approve by non-manager returns 403 | `apps/time-off-service/src/modules/auth/authorization.service.spec.ts` | AuthorizationService (RBAC, 403 hides existence) |
| REQ-LIFE-16 | Approve wrong-state returns 409 | `apps/time-off-service/src/modules/time-off/request-state-machine.spec.ts` | request state machine (TRD §5.1) |

## 3. HCM sync (REQ-SYNC-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-SYNC-01 | Saga uses realtime /balances/adjust | `apps/time-off-service/src/modules/hcm-sync/hcm-client.contract.spec.ts` | HcmClient (contract against mock HCM) |
| REQ-SYNC-02 | Every HCM write carries idempotency key | `apps/time-off-service/src/modules/hcm-sync/hcm-client.contract.spec.ts` | HcmClient (contract against mock HCM) |
| REQ-SYNC-03 | Verifies correlation_id + arithmetic on 2xx | `apps/time-off-service/src/modules/hcm-sync/hcm-response-check.spec.ts` | verifyAdjustResponse (expected-total arithmetic check, TRD §9.2) |
| REQ-SYNC-04 | Arithmetic mismatch flagged as ambiguous (F-04) | `apps/time-off-service/src/modules/hcm-sync/hcm-response-check.spec.ts` | verifyAdjustResponse (expected-total arithmetic check, TRD §9.2) |
| REQ-SYNC-04a | Post-commit async GET drift check enqueues point reconciliation | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| REQ-SYNC-05 | Every HCM interaction audited | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| REQ-SYNC-06 | Circuit breaker OPEN fast-fails | `apps/time-off-service/src/modules/hcm-sync/circuit-breaker.spec.ts` | CircuitBreaker FSM (TRD §11.2) |
| REQ-SYNC-07 | Retry uses original idempotency key | `apps/time-off-service/src/modules/hcm-sync/retry-policy.spec.ts` | computeBackoffMs (exponential backoff + full jitter, TRD §11.3) |
| REQ-SYNC-08 | F-05 triggers targeted point reconciliation, no batch | `apps/time-off-service/test/reconciliation.e2e-spec.ts` | Reconciliation surface, post-commit drift, and F-05 enqueue (e2e) |

## 4. Reconciliation (REQ-REC-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-REC-01 | Scheduler/admin creates RUNNING run with since= | `apps/time-off-service/src/modules/reconciliation/reconciliation.scheduler.spec.ts` | ReconciliationScheduler |
| REQ-REC-02 | Reconciliation updates safe drift | `apps/time-off-service/src/modules/reconciliation/reconciliation.service.spec.ts` | ReconciliationService (batch + point, TRD §9.3/§9.3) |
| REQ-REC-03 | Reconciliation refuses unsafe update | `apps/time-off-service/src/modules/reconciliation/reconciliation.service.spec.ts` | ReconciliationService (batch + point, TRD §9.3/§9.3) |
| REQ-REC-04 | Completed run carries final status + counts | `apps/time-off-service/src/modules/reconciliation/reconciliation.service.spec.ts` | ReconciliationService (batch + point, TRD §9.3/§9.3) |
| REQ-REC-05 | Idempotent re-run | `apps/time-off-service/src/modules/reconciliation/reconciliation.property.spec.ts` | reconciliation idempotence and INV-02 under interleave (property-based) |
| REQ-REC-06 | Only one reconciliation at a time | `apps/time-off-service/src/modules/reconciliation/reconciliation.service.spec.ts` | ReconciliationService (batch + point, TRD §9.3/§9.3) |

## 5. Defensive behaviors (REQ-DEF-*)

REQ-DEF-02/03/04 superseded by REQ-IDEM-* (§7); REQ-DEF-09 superseded by REQ-PII-01 + REQ-LOG-01 (§8).

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-DEF-01 | Invariants hold under all conditions | `apps/time-off-service/src/modules/time-off/invariants.property.spec.ts` | balance invariants under random operation sequences (property-based) |
| REQ-DEF-05 | Audit shares transaction with state | `apps/time-off-service/src/common/audit/audit.service.spec.ts` | AuditService (append-only, transaction-bound) |
| REQ-DEF-06 | Audit repository is insert-only | `apps/time-off-service/src/common/audit/audit.service.spec.ts` | AuditService (append-only, transaction-bound) |
| REQ-DEF-07 | HCM unreachable transitions to FAILED | `apps/time-off-service/test/hcm-resilience.e2e-spec.ts` | HCM resilience (e2e): retry exhaustion, breaker trip, 503 fast-fail |
| REQ-DEF-08 | OCC conflict retries up to 3 times | `apps/time-off-service/src/common/persistence/with-occ-retry.spec.ts` | withOccRetry |
| REQ-DEF-10 | Authz returns 403 without enumeration | `apps/time-off-service/src/modules/auth/authorization.service.spec.ts` | AuthorizationService (RBAC, 403 hides existence) |
| REQ-DEF-11 | Stuck-state sweep resolves stuck APPROVING | `apps/time-off-service/test/stuck-state-sweep.e2e-spec.ts` | Stuck-state sweep: APPROVING → APPROVED (case 1, HCM confirms) |
| REQ-DEF-12 | Sweep skips when circuit is OPEN | `apps/time-off-service/test/stuck-state-sweep.e2e-spec.ts` | Stuck-state sweep: breaker OPEN → sweep skipped entirely (REQ-DEF-12) |

## 6. API error contract (REQ-ERR-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-ERR-01 | RFC 7807 Problem Details shape | `apps/time-off-service/src/common/errors/domain-exception.filter.spec.ts` | DomainExceptionFilter |
| REQ-ERR-02 | Content-Type application/problem+json | `apps/time-off-service/src/common/errors/domain-exception.filter.spec.ts` | DomainExceptionFilter |
| REQ-ERR-03 | Validation failure → 400 with errors[] | `apps/time-off-service/src/common/errors/domain-exception.filter.spec.ts` | DomainExceptionFilter |
| REQ-ERR-04 | Stable documented type URIs | `apps/time-off-service/src/common/errors/domain-exception.filter.spec.ts` | DomainExceptionFilter |
| REQ-ERR-05 | correlation_id extension + generic fallback | `apps/time-off-service/src/common/errors/domain-exception.filter.spec.ts` | DomainExceptionFilter |

## 7. Client idempotency (REQ-IDEM-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-IDEM-01 | Idempotency-Key required on writes | `apps/time-off-service/test/idempotency.e2e-spec.ts` | Idempotency (e2e) |
| REQ-IDEM-02 | Missing/malformed key returns 400 | `apps/time-off-service/test/idempotency.e2e-spec.ts` | Idempotency (e2e) |
| REQ-IDEM-03 | Same key + body replays original | `apps/time-off-service/test/idempotency.e2e-spec.ts` | Idempotency (e2e) |
| REQ-IDEM-04 | Same key + different body returns 422 | `apps/time-off-service/test/idempotency.e2e-spec.ts` | Idempotency (e2e) |
| REQ-IDEM-05 | Record shares transaction; TTL cleanup | `apps/time-off-service/src/modules/time-off/idempotency.service.spec.ts` | IdempotencyService |

## 8. Observability & privacy (REQ-LOG-*, REQ-PII-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-LOG-01 | Correlation id propagated end-to-end | `apps/time-off-service/src/common/middleware/correlation-id.middleware.spec.ts` | CorrelationIdMiddleware |
| REQ-PII-01 | Logs redact employee PII | `apps/time-off-service/src/common/middleware/pii-redact.spec.ts` | PII redaction config (pino fast-redact) |

## 9. Availability surface (REQ-HEALTH-*, REQ-RATE-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-HEALTH-01 | Health reflects DB + breaker state | `apps/time-off-service/src/modules/health/health.service.spec.ts` | HealthService |
| REQ-RATE-01 | Throttle returns 429 RFC 7807 | `apps/time-off-service/test/rate-limit.e2e-spec.ts` | Rate limiting — per-IP throttle (e2e) |

## 10. Request listing (REQ-LIST-*)

| REQ ID | Behavior summary | Test file | Test |
|---|---|---|---|
| REQ-LIST-01 | Role-scoped keyset-paginated listing | `apps/time-off-service/src/modules/time-off/request-list.repository.spec.ts` | RequestRepository.list (keyset pagination) |

## 11. Invariants (INV-*)

| INV ID | Behavior summary | Test file | Test |
|---|---|---|---|
| INV-01 | reserved_days non-negative | `apps/time-off-service/src/modules/time-off/invariants.property.spec.ts` | balance invariants under random operation sequences (property-based) |
| INV-02 | available_days non-negative | `apps/time-off-service/src/modules/time-off/invariants.property.spec.ts` | balance invariants under random operation sequences (property-based) |
| INV-03 | reserved matches pending requests | `apps/time-off-service/src/modules/time-off/invariants.property.spec.ts` | balance invariants under random operation sequences (property-based) |
| INV-04 | HCM-crossed requests carry correlation_id | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| INV-05 | Audit log append-only | `apps/time-off-service/src/common/audit/audit.service.spec.ts` | AuditService (append-only, transaction-bound) |

## 12. State transitions (T-*)

| T ID | Transition | Test file | Test |
|---|---|---|---|
| T-01 | [*] → SUBMITTED | `apps/time-off-service/src/modules/time-off/request.service.spec.ts` | RequestService.submit (T-01 reservation) |
| T-02 | SUBMITTED → APPROVING | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| T-03 | APPROVING → APPROVED | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| T-04 | APPROVING → APPROVAL_FAILED | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| T-05 | APPROVAL_FAILED → APPROVING | `apps/time-off-service/test/retry.e2e-spec.ts` | Admin retry endpoints (e2e) |
| T-06 | APPROVAL_FAILED → CANCELLED | `apps/time-off-service/src/modules/time-off/cancel.service.spec.ts` | RequestService.cancel (router T-06/08/09, ADR-012) |
| T-07 | SUBMITTED → REJECTED | `apps/time-off-service/src/modules/time-off/reject.service.spec.ts` | RequestService.reject (T-07) |
| T-08 | SUBMITTED → CANCELLED | `apps/time-off-service/src/modules/time-off/cancel.service.spec.ts` | RequestService.cancel (router T-06/08/09, ADR-012) |
| T-09 | APPROVED → CANCELLING | `apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service.spec.ts` | CancellationSagaService (reverse saga T-09/10/11) |
| T-10 | CANCELLING → CANCELLED | `apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service.spec.ts` | CancellationSagaService (reverse saga T-09/10/11) |
| T-11 | CANCELLING → CANCELLATION_FAILED | `apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service.spec.ts` | CancellationSagaService (reverse saga T-09/10/11) |
| T-12 | CANCELLATION_FAILED → CANCELLING | `apps/time-off-service/test/retry.e2e-spec.ts` | Admin retry endpoints (e2e) |

## 13. Race scenarios (R-*)

| R ID | Scenario | Test file | Test |
|---|---|---|---|
| R-01 | Concurrent submissions exceed balance | `apps/time-off-service/test/submit-request.e2e-spec.ts` | POST /api/v1/requests (e2e) |
| R-02 | Submission/saga concurrent with reconciliation | `apps/time-off-service/src/modules/reconciliation/reconciliation.property.spec.ts` | reconciliation idempotence and INV-02 under interleave (property-based) |
| R-03 | Approval timeout followed by admin retry | `apps/time-off-service/test/retry.e2e-spec.ts` | Admin retry endpoints (e2e) |
| R-04 | HCM commit + local fail (OCC exhaustion) | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| R-05 | Cancel during APPROVING/CANCELLING | `apps/time-off-service/test/cancel-saga.e2e-spec.ts` | POST /api/v1/requests/:id/cancel (e2e) |
| R-06 | Reconciliation can't support reservations | `apps/time-off-service/src/modules/reconciliation/reconciliation.service.spec.ts` | ReconciliationService (batch + point, TRD §9.3/§9.3) |

## 14. Failure modes (F-*)

| F ID | Failure | Test file | Test |
|---|---|---|---|
| F-01 | HCM unreachable | `apps/time-off-service/src/modules/hcm-sync/hcm.errors.spec.ts` | HCM error taxonomy (ADR-008, TRD §11.1/§11.2) |
| F-02 | HCM timeout | `apps/time-off-service/src/modules/hcm-sync/hcm.errors.spec.ts` | HCM error taxonomy (ADR-008, TRD §11.1/§11.2) |
| F-03 | HCM 5xx | `apps/time-off-service/src/modules/hcm-sync/hcm.errors.spec.ts` | HCM error taxonomy (ADR-008, TRD §11.1/§11.2) |
| F-04 | Ambiguous response | `apps/time-off-service/src/modules/hcm-sync/hcm-response-check.spec.ts` | verifyAdjustResponse (expected-total arithmetic check, TRD §9.2) |
| F-05 | HCM 4xx insufficient_balance | `apps/time-off-service/test/reconciliation.e2e-spec.ts` | Reconciliation surface, post-commit drift, and F-05 enqueue (e2e) |
| F-06 | Local DB constraint mid-saga | `apps/time-off-service/src/modules/time-off/sagas/approval-saga.service.spec.ts` | ApprovalSagaService (forward saga T-02/03/04) |
| F-07 | Process crash mid-saga | `apps/time-off-service/test/stuck-state-sweep.e2e-spec.ts` | Stuck-state sweep: APPROVING → APPROVED (case 1, HCM confirms) |
| F-08 | Reconciliation drift conflict | `apps/time-off-service/src/modules/reconciliation/reconciliation.service.spec.ts` | ReconciliationService (batch + point, TRD §9.3/§9.3) |

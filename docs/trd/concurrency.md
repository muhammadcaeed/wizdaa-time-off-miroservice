# Concurrency Implementation

Companion to `TRD.md` §10. The TRD covers the reservation pattern, OCC, race-scenario mitigations, and transaction boundaries at the decision level. This file is the implementer's reference: detailed OCC pseudocode, the SQLite vs Postgres concurrency model, notes on concurrency-test realism, and the per-operation transaction-boundary table.

---

## 1. OCC protocol in detail

Compare-and-swap on every Balance write:

```
read:   SELECT total_days, reserved_days, version FROM balance WHERE id = :id
modify: compute new total_days, new reserved_days in memory
write:  UPDATE balance
        SET total_days = :new_total,
            reserved_days = :new_reserved,
            version = version + 1
        WHERE id = :id AND version = :observed_version
```

If the UPDATE reports zero rows affected, a concurrent writer changed the row between the read and the write. The caller re-reads and retries the modify step. Maximum 3 retries. After exhaustion, the operation returns 409 Conflict and the caller backs off.

The `version + 1` in the SET clause is what makes the CAS work. SQLite and Postgres both treat the WHERE predicate atomically with the SET, so a successful UPDATE means the row was exactly in the expected state when the write landed. The version increment also defends against ABA: a row cycling A → B → A still has a different version, so a stale read of state A followed by a CAS write fails.

---

## 2. Status-predicate CAS on TimeOffRequest

State transitions on `TimeOffRequest` use the same pattern with status instead of version:

```
UPDATE time_off_request
SET status = :new_status, ...
WHERE id = :id AND status = :expected_status
```

A zero-row result means another writer transitioned the row first. Common cases:

- Two managers concurrently approve and reject the same SUBMITTED request
- A manager approval lands at the same moment an admin retry is firing
- A cancellation arrives while the request is in APPROVING (also guarded by R-05's explicit cancel-state check)

The caller maps zero-row to `/errors/invalid-state-transition` (409) without retry. The safe interpretation is that someone else already acted on this request, and the action shouldn't be repeated.

This is the second half of R-05's mitigation. The first half is the explicit cancel-state guard that returns 409 when the request is in APPROVING or CANCELLING. See TRD §10.3.

---

## 3. SQLite vs Postgres concurrency model

SQLite serializes writers at the database level even in WAL mode: one writer at a time, readers proceed concurrently with the writer. The optimistic CAS still works correctly because every write either succeeds with the predicate satisfied or fails with zero rows affected.

What differs from Postgres is the contention behavior under heavy concurrent load on the same `(employee, location)` row:

- **SQLite**: serializes the attempts rather than letting them race in parallel. The test suite observes fewer CAS retries than it would on Postgres because the database itself is queuing writers.
- **Postgres**: allows true row-level concurrency. Multiple writers may hit the CAS predicate near-simultaneously; only one's UPDATE will satisfy the version check; the others retry from a fresh read.

The concurrency tests (see `test-strategy.md` §1) exercise the CAS retry logic against SQLite with `Promise.all`-driven Node-level interleaving. The realism is reduced relative to true multi-process parallelism but the correctness invariants (INV-01 through INV-05) hold identically. Property-based tests (`test-strategy.md` §5) push on the same surface with longer random operation sequences.

The Postgres migration path is open. Postgres can additionally use `SELECT FOR UPDATE` for pessimistic locking on hot keys if profiling shows them; advisory locks are another option for distributed-coordination patterns above the row level. The design doesn't require either; ADR-005 captures the reasoning.

---

## 4. The version column and reconciliation

Reconciliation updates the Balance row directly (`total_days = hcm_total_days`, possibly also adjusting `reserved_days` from the sum-of-pending recomputation). Every reconciliation update increments `version` like any other write. A submission in flight against the same row at the same moment will lose the CAS, re-read, and either succeed against the refreshed total or fail with insufficient balance. This is R-02's mitigation; the version-column pattern carries it automatically.

The reconciliation algorithm pseudocode is in `hcm-integration.md` §2.

---

## 5. Per-operation transaction boundaries

Each state change is one DB transaction containing the entity update, the related balance update if any, and the audit log entry. All `TimeOffRequest` status updates use a status-predicate CAS; all `Balance` updates use a version-check CAS. Zero-row results trigger the appropriate response per §1 and §2.

| Operation | Atomic in one DB transaction |
|---|---|
| Submit (T-01) | INSERT TimeOffRequest + UPDATE Balance (reserved +=) with version check + retry + INSERT AuditLog + INSERT IdempotencyRecord |
| Manager approves (T-02) | UPDATE TimeOffRequest.status (→ APPROVING) with status-predicate CAS + INSERT AuditLog. No balance change. |
| Approval commit (T-03) | UPDATE Balance (total −=, reserved −=) with version check + retry + UPDATE TimeOffRequest (→ APPROVED, `hcm_correlation_id`) with status-predicate CAS + INSERT AuditLog |
| Approval failure (T-04) | UPDATE Balance (reserved −=) with version check + retry + UPDATE TimeOffRequest (→ APPROVAL_FAILED, `failure_reason`) with status-predicate CAS + INSERT AuditLog |
| Reject (T-07) | UPDATE Balance (reserved −=) with version check + UPDATE TimeOffRequest (→ REJECTED) with status-predicate CAS + INSERT AuditLog |
| Cancel pre-approval (T-08) | UPDATE Balance (reserved −=) with version check + UPDATE TimeOffRequest (→ CANCELLED) with status-predicate CAS + INSERT AuditLog |
| Cancel approved (T-09) | UPDATE TimeOffRequest.status (→ CANCELLING) with status-predicate CAS + INSERT AuditLog. No balance change. |
| Cancellation commit (T-10) | UPDATE Balance (total +=) with version check + retry + UPDATE TimeOffRequest (→ CANCELLED) with status-predicate CAS + INSERT AuditLog |
| Per-balance reconciliation | UPDATE Balance with version check + INSERT AuditLog (or just an AuditLog entry in the conflict case) |

The cross-system part of the saga (the HCM call between two local transactions) is documented in TRD §10.4. The audit log shares the commit boundary with the state change it describes, which is what enforces INV-05 in practice.

---

## 6. Cross-references

- Reservation pattern (counter model): TRD §10.1, ADR-001
- Race scenarios (R-01 through R-06): TRD §10.3
- Saga shape (HCM call between two local transactions): TRD §10.4, ADR-002
- Concurrency test layer: `test-strategy.md` §1
- Property-based tests for invariants: `test-strategy.md` §5
- Postgres migration as a designed-for extension: see TRD §15 (tech stack) and ADR-005

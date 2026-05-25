# ADR-011: Point reconciliation is untracked and enqueued through an in-process async queue

**Status**: Accepted

## Context

Plan 04 introduces point reconciliation (TRD §9.3): a targeted refresh of a single `(employee, location)` balance from the HCM realtime read. It is triggered from three call sites:

- the F-05 path (HCM 409 insufficient balance after local validation passed; REQ-SYNC-08),
- the F-04 path (ambiguous adjust response; REQ-SYNC-04),
- the post-commit drift sanity check after a successful saga commit (REQ-SYNC-04a).

Two design questions arise that the TRD does not settle explicitly:

1. **Is a point reconciliation a tracked `Reconciliation` resource?** The `Reconciliation` table carries a partial UNIQUE index `WHERE status = 'RUNNING'` enforcing at most one running run (REQ-REC-06). The `trigger_type` enum includes a `POINT` value.

2. **How is a point reconciliation "enqueued"?** REQ-SYNC-04a requires the post-commit check to be asynchronous and non-blocking: it must not add latency to the saga's 202 response and must never roll back a committed transition. F-05 and F-04 enqueues share the same "fix the local total out of band" intent.

## Decision

**Point reconciliations are not tracked as `Reconciliation` rows.** The §9.3 pseudocode has no run resource — it is a single transaction over one balance, audited via `balance.point_reconciled` / `balance.point_reconciliation.conflict`. Persisting a `RUNNING` row for a point recon would collide with the partial UNIQUE index whenever a batch or on-demand run is in flight, turning a routine drift fix into a spurious 409/constraint error. The unused `POINT` value is removed from the `ReconciliationTrigger` type rather than left dead.

**Point reconciliations are enqueued through a thin in-process `PointReconciliationQueue` abstraction.** The default implementation schedules the work on `process.nextTick` (fire-and-forget; the saga response is already sent), swallows and audits failures, and never propagates back into the saga. Tests substitute an implementation exposing `drain()` so they can deterministically assert the resulting audit row and balance mutation.

The same queue serves all three call sites (F-04, F-05, post-commit drift). Injecting it into the approval saga is coordination, not reconciliation logic: the saga still owns only its own state machine and delegates the drift fix.

## Consequences

**Positive:**
- No false `reconciliation-in-progress` conflicts between point recons and batch runs.
- The saga's 202 latency is unaffected by the post-commit drift read (REQ-SYNC-04a).
- One mechanism, three callers — the abstraction earns its place on the rule of three.
- A point recon failure can never roll back or destabilize a committed saga.

**Negative:**
- **Durability gap**: a process crash drops queued point reconciliations. This is acceptable *only because* the scheduled batch reconciler (TRD §9.3) is the backstop that eventually catches the same drift on its next cycle. This dependency is load-bearing and is documented on the queue itself.
- **No run-level audit for point recons**: observability is per-balance (`balance.point_reconciled` / `.conflict`) only; there is no "how many points fired today" run record. The per-balance audit rows are the sole source for that question.
- The queue is in-process and single-instance; a future multi-instance deployment (requirements.md §2.4, Postgres) would need a durable queue. Out of scope here.

## Alternatives Considered

1. **Track point recons as `Reconciliation` rows with `trigger_type = POINT`.** Rejected: collides with the partial UNIQUE index during concurrent batch runs; adds a resource lifecycle the §9.3 algorithm does not need.

2. **Scope the UNIQUE index to `trigger_type IN ('SCHEDULED','ON_DEMAND')`** so point rows can coexist. Rejected: still pays for run-row bookkeeping the algorithm does not use, and complicates the index for no observability gain over per-balance audit.

3. **Synchronous point reconciliation inside the saga.** Rejected: violates REQ-SYNC-04a (must not add hot-path latency) and risks coupling a committed transition's fate to a follow-up HCM read.

4. **A durable persisted queue (table-backed) with retry.** Rejected as over-engineering for a single-instance service; the scheduled batch reconciler already provides eventual catch-up. Revisit on the Postgres/multi-instance extension (TRD §13.4).

Linked ADRs: ADR-006 (sync strategy), ADR-008 (resilience), ADR-005 (optimistic concurrency).

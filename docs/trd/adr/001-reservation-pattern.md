# ADR-001: Reservation pattern over immediate balance decrement

**Status**: Accepted

## Context

The service maintains a local model of HCM balances and processes time-off requests through an approval lifecycle. Between submission and approval, a request represents intent: the employee has committed to the days, but HCM doesn't know yet. The design has to handle three forces:

- Concurrent submissions for the same employee (two tabs, two devices) must not corrupt the balance
- HCM should not be called for requests that never reach approval; round-trip cost, latency, and blast radius all matter
- HCM can change underneath the service (anniversary grants, year-end refresh, manual HR edits); the local model must absorb that drift cleanly

## Decision

Balance state carries two counters:

- `total_days`: sourced from HCM, authoritative; updated only when HCM confirms a change or reconciliation observes drift
- `reserved_days`: a local counter equal to the sum of `days_requested` across all pending requests for that `(employee, location)`

Available balance is `total_days - reserved_days`. Submissions increment `reserved_days` under an optimistic version check (ADR-005). Approval calls HCM, then atomically decrements both counters. Rejection and pre-approval cancellation decrement only `reserved_days`.

## Consequences

**Positive:**
- Concurrent submissions can't corrupt; the version check serializes them per row
- HCM is contacted only at approval, not at submission. Reduces HCM load and gives the user instant feedback on submission.
- HCM rejection costs nothing locally; the reservation is released and `total_days` is untouched
- Reconciliation updates `total_days` without touching `reserved_days`; in-flight requests are preserved automatically

**Negative:**
- Two counters per balance row adds a small amount of state-management complexity
- The denormalized counter could drift from the underlying request rows if a bug is introduced; mitigated by INV-03, which is verified by property-based tests
- Cancellation of approved leave requires a separate saga in reverse (handled by ADR-002 and TRD §5)

## Alternatives Considered

1. **Immediate decrement on submission.** Decrement `total_days` at submit, increment back on rejection. Rejected: couples local state to a promise HCM hasn't honored; rejection requires a compensating HCM call that itself can fail; every submission becomes an HCM round-trip; HCM load scales with submissions, not approvals.

2. **Compute reservations on the fly (no denormalized counter).** Calculate reservation at read time by summing pending requests. Rejected: concurrent submissions race because the available-days calculation isn't part of an atomic CAS; requires aggregation on every read; atomic CAS on a single counter is both simpler and faster.

3. **Pessimistic locking per (employee, location).** Hold a lock across the entire submission. Rejected: kills throughput on the contended row; doesn't help with HCM coordination; SQLite's pessimistic semantics differ from Postgres, breaking portability.

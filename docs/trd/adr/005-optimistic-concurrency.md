# ADR-005: Optimistic concurrency control with version column

**Status**: Accepted

## Context

Multiple writers act on a Balance row concurrently: submissions increment `reserved_days`, approvals decrement both counters, cancellations release reservations, reconciliation updates `total_days`. Without coordination, concurrent writes corrupt counters and violate INV-01, INV-02, INV-03. Three forces:

- Per-row contention is low in steady state; collisions are rare
- The chosen pattern must port from SQLite (development) to Postgres (production) without code changes
- Locks held across HCM calls would block reconciliation and serialize the system unnecessarily

## Decision

Optimistic concurrency control with a `version` column on the Balance row. Every UPDATE carries `WHERE version = :observed_version` and increments `version` by 1. A zero-row-affected result indicates a concurrent writer changed the row; the caller retries from a fresh read. Maximum 3 retries; after exhaustion, the operation returns 409 Conflict and the caller backs off.

## Consequences

**Positive:**
- No locks held across HCM calls or other latency-incurring operations
- Identical code works on SQLite and Postgres
- Cheap in the common case: one CAS per write, no lock acquisition
- The version column also defends against ABA (a row that cycles A → B → A still has a different version)

**Negative:**
- Pathological contention (many writers, same key) produces retry storms; the 3-attempt cap and 409 fallback bound the worst case
- Retry logic must avoid duplicate side effects (e.g., calling HCM twice on retry); resolved by structuring HCM calls outside the OCC retry loop (the saga design in ADR-002)

## Alternatives Considered

1. **Pessimistic locking (`SELECT FOR UPDATE` / `BEGIN IMMEDIATE`).** Acquire a row-level lock at read time. Rejected: SQLite's pessimistic semantics effectively serialize the entire database via `BEGIN IMMEDIATE`, while Postgres uses true row-level locking; behavior diverges between environments and breaks portability. Long-held locks also conflict with reconciliation.

2. **Application-level mutex per (employee, location).** In-process map of mutexes keyed by employee+location. Rejected: works only in single-instance deployment; fails on horizontal scaling because mutexes don't span processes; would require a distributed lock manager (Redis, Zookeeper), which adds a dependency without addressing the cross-database portability concern.

3. **Default database serialization (no explicit handling).** Rely on SQLite's WAL-mode serialization at the storage layer. Rejected: implicit and not part of the application contract; doesn't survive the Postgres migration (different default isolation level); hides the design intent from the code and from anyone auditing concurrency safety.

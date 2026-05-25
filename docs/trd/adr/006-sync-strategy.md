# ADR-006: HCM sync via realtime hot path + scheduled batch reconciliation

**Status**: Accepted

## Context

The HCM exposes two integration channels: a realtime API for individual balance reads and writes, and a batch endpoint for the full corpus. The service has to decide which channel to use when, and how to handle HCM-side changes the service didn't initiate. Three forces:

- Read latency matters; balance reads happen frequently and shouldn't depend on HCM availability
- Write operations (approval, cancellation) need authoritative confirmation from HCM
- HCM-side changes (anniversary grants, year-end refresh, manual HR edits, other consumer systems) happen without notification to the service

## Decision

A hybrid sync model:

- **Read path** serves from local Balance cache without any HCM call
- **Write path** makes a realtime HCM call (decrement on approval, increment on cancellation), gates the local commit on a 2xx response whose `new_total_days` matches `pre_total + delta`, and then commits locally in an atomic transaction. An asynchronous post-commit drift check feeds reconciliation when external writers are detected (TRD §9.2 items 2 and 3).
- **Reconciliation path** runs on a configurable schedule (15 min in development, 60 min in production), is triggerable on demand via `POST /reconciliations`, and has a targeted point variant (TRD §9.3) for single-balance drift events

Reconciliation pulls the batch endpoint with `since=<last_completed_at>` and resolves drift: HCM wins for `total_days`, local wins for `reserved_days`. If HCM total can't support local reservations, the run flags a conflict and refuses to update (admin remediation per TRD §9.3).

## Consequences

**Positive:**
- Reads are fast and remain available during HCM downtime
- Writes commit on a self-consistent HCM response (2xx + arithmetic match), avoiding the multi-writer false positives that a synchronous verification GET would create
- Post-commit drift detection still surfaces external writers, but asynchronously, so user-facing latency stays bounded
- Each channel is used for what it's best at: realtime for single low-latency operations, batch for high-throughput corpus catch-up
- Multi-writer HCM updates are caught without requiring webhooks

**Negative:**
- The local cache can be stale by up to one reconciliation interval; user reads may not reflect HCM-side changes immediately
- Reconciliation cadence is a tuning parameter; too aggressive overloads HCM, too lax leaves users with stale data
- Two code paths to test and maintain
- If HCM later offers webhooks, the batch path could be augmented or replaced (designed-for extension in TRD §13.4)

## Alternatives Considered

1. **Realtime only.** Call HCM on every read and write. Rejected: ties read availability to HCM availability; saturates HCM with traffic that doesn't need to be there; user-facing read latency becomes HCM-latency-bound.

2. **Local cache with write-through, no reconciliation.** Reads from local, writes to both. Rejected: doesn't handle HCM-side changes the service didn't initiate; the local cache would silently drift over time until it no longer matched reality.

3. **Continuous (event-driven) sync after every write.** Reconcile after every write operation. Rejected: expensive and mostly redundant because the local cache is already updated by the saga commit; reconciliation's purpose is to catch external changes, which an event-driven approach wouldn't detect any better than scheduled.

4. **Webhook-driven (HCM pushes change notifications).** Eliminates batch polling. Rejected for current scope: the HCM contract in TRD §9.1 doesn't specify webhook support; designing around a feature that may not exist in production HCMs would be premature; mentioned as a designed-for extension in TRD §13.4.

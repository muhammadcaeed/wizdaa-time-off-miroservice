# Architecture Decision Records

ADRs follow Nygard format: **Context** (what's true now, what forces are at play), **Decision** (what we chose), **Consequences** (positive and negative outcomes), **Alternatives Considered** (what we evaluated and rejected, with reasons).

| ID | Title | Status | Summary |
|---|---|---|---|
| [ADR-001](./001-reservation-pattern.md) | Reservation pattern over immediate balance decrement | Accepted | Two counters per balance (`total_days` + `reserved_days`); HCM contacted only at approval |
| [ADR-002](./002-saga-pattern.md) | Saga over 2PC for HCM coordination | Accepted | Two local transactions bracket each HCM call; explicit `*_FAILED` states for partial failures |
| [ADR-003](./003-jwt-auth.md) | JWT bearer stub for authentication | Accepted | HS256 stub demonstrating the principal/RBAC contract; clean upgrade path to OIDC + JWKS |
| [ADR-004](./004-rest-vs-graphql.md) | REST over GraphQL | Accepted | Narrow transactional surface; idempotency, RFC 7807, cursor pagination via standard HTTP tooling |
| [ADR-005](./005-optimistic-concurrency.md) | Optimistic concurrency control with version column | Accepted | CAS via `version` column; portable across SQLite and Postgres |
| [ADR-006](./006-sync-strategy.md) | HCM sync via realtime hot path + scheduled batch reconciliation | Accepted | Realtime for writes, local cache for reads, batch for catch-up, point recon for targeted drift |
| [ADR-007](./007-idempotency.md) | Idempotency strategy: `request_id + operation_type` compound key | Accepted | Deterministic key; survives retries and restarts; distinguishes decrement from increment |
| [ADR-008](./008-resilience.md) | HCM client resilience: retry with backoff + circuit breaker | Accepted | Retry-inside-breaker; hand-rolled state machine; thresholds env-configurable |
| [ADR-009](./009-monorepo-layout.md) | NestJS monorepo layout for service + mock HCM | Accepted | `apps/time-off-service` + `apps/mock-hcm`; NestJS monorepo mode |
| [ADR-010](./010-fk-enforcement.md) | Foreign-key enforcement strategy | Accepted | App-layer integrity, no SQL FK; matches defensive-mirror sync model. Finalized at cycle 02 start |
| [ADR-011](./011-point-reconciliation-async-queue.md) | Point reconciliation via async in-process queue | Accepted | Targeted single-balance drift fixed out of band on `nextTick`; batch reconciler is the backstop |
| [ADR-012](./012-cancellation-routing.md) | Cancellation routing — advisory read, authoritative CAS | Accepted | `RequestService.cancel` routes by state; saga path delegates; stale read → 409, never re-route |

## How decisions cross-reference

- **Reservation pattern (ADR-001)** depends on **optimistic concurrency (ADR-005)** for safe concurrent submissions
- **Saga (ADR-002)** depends on **idempotency (ADR-007)** so retries don't double-apply, and on **resilience (ADR-008)** for the retry/breaker policy that wraps every HCM call
- **Sync strategy (ADR-006)** uses **saga (ADR-002)** on the write path and **OCC (ADR-005)** for reconciliation merges
- **JWT auth (ADR-003)** and **REST choice (ADR-004)** are independent of the rest

## Adding a new ADR

1. Copy the format of an existing accepted ADR
2. Number sequentially (next is `009-...md`)
3. Set status to `Proposed` initially; switch to `Accepted` after review
4. Add a row to the table above
5. Cross-reference from the TRD section where the decision is exercised

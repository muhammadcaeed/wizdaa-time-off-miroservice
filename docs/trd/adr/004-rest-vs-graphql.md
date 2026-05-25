# ADR-004: REST over GraphQL

**Status**: Accepted

## Context

The brief allows either REST or GraphQL. The service has a small, stable, resource-oriented surface (requests, balances, reconciliations) with explicit state transitions, and consumers need idempotency, RFC 7807 errors, and cursor pagination.

## Decision

REST. Resources map to HTTP paths (`/balances/employees/:id`, `/requests/:id`, `/reconciliations`). State transitions use action sub-resources (`/requests/:id/approve`, `/approval-retries`). Errors use RFC 7807. Pagination is cursor-based. Writes carry `Idempotency-Key`.

GraphQL's strengths (flexible cross-resource queries, schema-driven client evolution, federation across many services) don't pay back for a narrow transactional surface. The federation story, if it ever applies, belongs at a gateway above multiple backend services, not at the per-service layer. HTTP method semantics and standard operational tooling (per-endpoint metrics, rate limiting, caching, idempotency headers) align cleanly with this service's defensive requirements.

## Consequences

**Positive:**
- Each endpoint is independently rate-limitable, observable, and cacheable
- Idempotency works with standard tooling
- A future GraphQL gateway can wrap this service's REST endpoints without redesign

**Negative:**
- Clients fetching related resources do N requests instead of one query (not a real cost at this scope)
- No built-in introspection (OpenAPI documents the contract separately)
- Action sub-resources aren't pure REST (pragmatic REST treats them as accepted "controller resources" per Stripe/GitHub/AWS patterns)

## Alternatives Considered

1. **GraphQL code-first with NestJS.** Query flexibility offers no value for fixed-shape operations; idempotency-key semantics require GraphQL-specific tooling. Rejected.

2. **Hybrid REST + GraphQL.** Doubles the surface area; the two styles diverge over time. Rejected.

3. **PATCH-based state transitions (`PATCH /requests/:id` with `{ status: ... }`).** Overloads one endpoint with too many distinct validations, actors, and side effects. Rejected.

4. **gRPC.** Consumers are web-layer code where HTTP/JSON is the lingua franca; gRPC's benefits don't pay back here. Rejected.

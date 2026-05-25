# API Contract

Companion to `TRD.md`. The TRD covers the auth model and the API philosophy at a summary level; this file is the implementer's reference: full endpoint list, authorization rules, error envelope, idempotency semantics, pagination, and async polling.

## 1. URL scheme and versioning

All endpoints live under `/api/v1`. Versioning is via URL prefix. Breaking changes ship under `/api/v2` with `/api/v1` maintained until consumers migrate.

The full OpenAPI 3.0 specification is generated at build time via the `@nestjs/swagger` module (DTO classes are annotated with `@ApiProperty` and controllers with `@ApiOperation` / `@ApiResponse`). The generated `openapi.json` is committed to the repo on every change; an interactive Swagger UI is mounted at `/api/v1/docs` in non-production builds. This document is the prose contract; `openapi.json` is the machine-readable one. The two are kept in sync by a CI check that fails the build if the generated spec drifts from the committed copy.

## 2. Endpoint reference

| Method | Path | Purpose | Authorized roles | Idempotency-Key | Success | Notable errors |
|---|---|---|---|---|---|---|
| GET | `/api/v1/balances/employees/:employee_id` | Read balance(s) for an employee | Employee (own), Manager (direct reports), Admin | n/a | 200 + Balance list | 403, 404 |
| GET | `/api/v1/requests` | List requests (paginated, filterable) | Scoped by role | n/a | 200 + cursor page | 400, 403 |
| POST | `/api/v1/requests` | Submit a new request | Employee (self) | required | 201 + Request (SUBMITTED) | 400 (validation), 403, 409 (insufficient balance) |
| GET | `/api/v1/requests/:id` | Read a single request | Owner, Manager of owner, Admin | n/a | 200 + Request | 403, 404 |
| POST | `/api/v1/requests/:id/approve` | Manager approves | Manager of owner | required | 202 + Request (APPROVING) | 403, 404, 409 (wrong state) |
| POST | `/api/v1/requests/:id/reject` | Manager rejects | Manager of owner | required | 200 + Request (REJECTED) | 403, 404, 409 |
| POST | `/api/v1/requests/:id/cancel` | Cancel (owner pre-approval, owner if future-dated approved, Admin from any cancellable state) | Owner or Admin | required | 200 + Request (CANCELLED) or 202 (CANCELLING for approved future-dated) | 403, 404, 409 |
| POST | `/api/v1/requests/:id/approval-retries` | Retry a failed approval saga | Admin | required | 202 + Request (APPROVING) | 403, 404, 409 |
| POST | `/api/v1/requests/:id/cancellation-retries` | Retry a failed cancellation saga | Admin | required | 202 + Request (CANCELLING) | 403, 404, 409 |
| POST | `/api/v1/reconciliations` | Trigger a reconciliation run | Admin | required | 202 + Reconciliation (RUNNING) | 403, 409 (another run in flight) |
| GET | `/api/v1/reconciliations` | List reconciliation runs | Admin | n/a | 200 + cursor page | 403 |
| GET | `/api/v1/reconciliations/:id` | Read a reconciliation run | Admin | n/a | 200 + Reconciliation | 403, 404 |
| GET | `/api/v1/health` | Health check (service + DB + HCM connectivity) | unauthenticated | n/a | 200 healthy / 503 degraded | none |

Status code choices:
- **202 Accepted** for operations that start an asynchronous saga (approve, retries, cancel-when-approved, reconcile). The body describes the in-flight state; the client polls or waits for the eventual outcome.
- **200 OK** for synchronous terminal operations (reject, cancel-when-not-approved).
- **409 Conflict** for state-mismatch errors (calling approve on something already approved, insufficient balance, etc.).

## 3. Authentication and authorization

Authentication is via `Authorization: Bearer <jwt>`. The JWT carries `sub` (employee_id) and `roles` (array of EMPLOYEE, MANAGER, ADMIN). Verification happens at a global guard; controllers receive a typed principal.

Authorization is enforced per endpoint and per resource:

| Role | Can do |
|---|---|
| EMPLOYEE | Read own balance, submit requests for self, read own requests, cancel own requests |
| MANAGER | All EMPLOYEE actions plus: read balances and requests of direct reports (employees where `manager_id = self.id`), approve and reject those requests |
| ADMIN | All MANAGER and EMPLOYEE actions across all employees, plus: trigger retries and reconciliation, cancel any cancellable request |

An employee can hold multiple roles (a manager is also an employee). Authorization is a union: the most permissive applicable rule wins.

Authorization predicates beyond role (e.g., "manager of the request's owner") are enforced inside the handler after loading the resource. Failure produces 403 with the resource hidden (the client cannot distinguish "doesn't exist" from "you can't see it") to prevent enumeration. See ADR-003 for the rationale on the JWT stub.

## 4. Error envelope (RFC 7807)

All error responses use the Problem Details for HTTP APIs format (RFC 7807).

```json
{
  "type": "https://errors.example.com/insufficient-balance",
  "title": "Insufficient balance",
  "status": 409,
  "detail": "Available balance (3 days) is less than requested (5 days).",
  "instance": "/api/v1/requests",
  "correlation_id": "01HXYZ...",
  "timestamp": "2026-05-24T15:30:00Z",
  "available_days": 3,
  "requested_days": 5,
  "employee_id": "emp_abc",
  "location_id": "loc_xyz"
}
```

Fields beyond `type`, `title`, `status`, `detail`, `instance` are RFC 7807-compliant extensions. Domain-specific error types:

- `/errors/insufficient-balance` (409)
- `/errors/invalid-state-transition` (409)
- `/errors/idempotency-conflict` (422; same key, different body)
- `/errors/request-not-found` (404)
- `/errors/balance-not-found` (404)
- `/errors/forbidden` (403)
- `/errors/validation` (400; with `errors` array of field-level details)
- `/errors/hcm-unavailable` (503; circuit breaker open)
- `/errors/reconciliation-in-progress` (409)

## 5. Pagination

Cursor-based, opaque cursor. Avoids the offset-skew problem under concurrent writes.

Query parameters: `?cursor=<opaque>&limit=<integer, default 50, max 100>`.

Response shape:

```json
{
  "data": [ /* resource list */ ],
  "pagination": {
    "next_cursor": "eyJpZCI6Li4ufQ==",
    "has_more": true
  }
}
```

`next_cursor` is null when `has_more` is false. The cursor encodes `(sort_field, id)` and is opaque to the client. Stable across schema changes via versioning embedded in the cursor.

## 6. Idempotency (client-facing)

`Idempotency-Key: <client-generated UUID v4>` required on all write endpoints (POST). Semantics:

- The server stores `(key, request_hash, response_body, response_status, expires_at)` in the `IdempotencyRecord` table for 24 hours.
- Same key with the same request hash returns the original response without re-executing.
- Same key with a different request hash returns 422 `/errors/idempotency-conflict`.
- Missing key on a write endpoint returns 400 with a hint explaining the requirement.
- A periodic cleanup job removes records past `expires_at` to keep the table bounded.

The record is written in the same transaction as the original operation's outcome, so a successful write and its idempotency record are atomic. On a duplicate, the response is reconstructed from the stored body and status without re-touching domain state.

This is distinct from the HCM-side idempotency strategy (`request_id + operation_type`; ADR-007). Client-facing idempotency protects against double-submission. HCM-side idempotency protects against duplicate downstream effects during retries.

Linked ADRs: [ADR-004](./adr/004-rest-vs-graphql.md) (REST choice), [ADR-007](./adr/007-idempotency.md) (idempotency strategy).

## 7. Asynchronous operation polling

Endpoints that return 202 Accepted (approve, post-approval cancel, retries) hand the client a request in an intermediate state (`APPROVING` or `CANCELLING`). The final state arrives on the next saga commit, which under normal conditions is sub-second but can take longer during HCM degradation.

Clients observe the final state by polling `GET /api/v1/requests/:id`. Recommended behavior:

- Initial wait 200ms, then exponential backoff with full jitter: 200ms, 400ms, 800ms, capped at 2s, for up to 30 seconds total.
- Stop polling when `status` is in `{APPROVED, APPROVAL_FAILED, REJECTED, CANCELLED, CANCELLATION_FAILED}`.
- If still in `APPROVING` or `CANCELLING` after 30 seconds, surface the in-flight state to the user and either retry the poll later or treat the request as stuck (the stuck-state sweep in TRD §11.4 will resolve it within its threshold + interval).

The response envelope on `GET /requests/:id` includes a `last_transitioned_at` timestamp so the client can decide whether to continue polling. Server-Sent Events or long-polling are documented as production extensions but are not in this service's API surface.

## 8. Rate limiting

Per-IP and per-`sub` limits via `@nestjs/throttler`. Defaults: 10/min per IP, 30/min per `sub` on POST endpoints; 60/min per IP on read endpoints. All limits are env-configurable. Distributed (Redis-backed) limiting is a production extension. See TRD §13.4.

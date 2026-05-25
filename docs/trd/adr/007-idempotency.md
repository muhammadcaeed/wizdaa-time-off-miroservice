# ADR-007: Idempotency strategy (`request_id + operation_type` compound key)

**Status**: Accepted

## Context

HCM writes have to be idempotent under retries (network failures, timeouts, ambiguous responses, process crashes). The idempotency key has to satisfy four properties:

- Uniquely identify the logical operation
- Be deterministic so retries reproduce the same key without persisting it
- Distinguish multiple operations on the same request (a decrement followed by an increment for cancellation)
- Survive process restarts and admin-initiated retries

## Decision

The idempotency key for HCM write operations is `<request_id>:<operation_type>`, where `operation_type` is either `decrement` or `increment`.

Examples:
- Approval saga: `req_abc123:decrement`
- Cancellation saga: `req_abc123:increment`

The key is computed deterministically from local state at the moment of the HCM call. No additional storage is needed. Any retry (automatic or admin-triggered) reproduces the same key from the same local state.

Client-to-service idempotency is a separate concern, handled by the `Idempotency-Key` header (client-generated UUID) described in api-contract.md.

## Consequences

**Positive:**
- Deterministic: a retry computes the same key without needing to remember anything
- Survives process restarts and concurrent retry attempts
- Distinguishes decrement from increment for the same request, which matters because both can happen in a request's lifecycle (approved, then cancelled before start_date)
- Compatible with the HCM's documented idempotency semantics (same key returns the same response)

**Negative:**
- The key embeds operation type, so adding a new operation type requires the new caller to follow the canonical naming
- HCM's idempotency guarantee is soft (per TRD §9.1); the design verifies outcomes via the pre-write expected-total arithmetic check (TRD §9.2 item 2) plus async drift detection rather than trusting 2xx alone
- Key length grows with `request_id` length; UUIDs are fine, but longer ID schemes might approach HCM's per-key length limits. The HCM-side maximum is a deferred concern in TRD §13.4

## Alternatives Considered

1. **Request UUID alone as idempotency key.** Use just `request_id`. Rejected: doesn't distinguish decrement from increment, so a cancel-after-approve would either collide with the original decrement key or require additional state to differentiate; the same request can legitimately produce two HCM operations.

2. **Random UUID per call, persisted in local DB.** Generate a fresh idempotency key per attempt and store it. Rejected: requires durable persistence of the key before the HCM call; retries must read the stored key; adds complexity and a write step that itself could fail mid-saga.

3. **Pass through the client's `Idempotency-Key` header to HCM.** Use the same key the client provides to the service for its outbound HCM call. Rejected: conflates two layers of idempotency that have different scopes and TTLs (client-facing is 24h, HCM-side is unbounded for the request lifecycle); the service should own its outbound idempotency story rather than expose it as a function of caller behavior.

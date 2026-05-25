# ADR-008: HCM client resilience (retry with backoff + circuit breaker)

**Status**: Accepted

## Context

HCM is an external system with unreliable response behavior. The client has to recover from transient failures (network blips, brief 5xx, momentary timeouts), avoid amplifying a sustained HCM outage with a retry storm, surface clear failures to users when recovery isn't possible, and protect the service's own resources from being consumed by stuck HCM calls.

## Decision

Two complementary mechanisms.

**Retry policy** for transient failures:
- Max 3 retries (4 total attempts including the original)
- Exponential backoff with full jitter; base 100ms, doubled each attempt (100, 200, 400ms), capped at 5s
- Retries reuse the original idempotency key (ADR-007)
- Only retryable errors trigger retries: F-01 (network), F-02 (timeout), F-03 (5xx)
- F-04 (ambiguous), F-05 (4xx insufficient balance), and F-06 (local DB error) are not retried

**Circuit breaker** for sustained failures:
- States: CLOSED, OPEN, HALF_OPEN (described in TRD §11.2)
- Opens after 5 consecutive failures or 50% failure rate in the last 10 calls
- OPEN cool-down: 30 seconds, then transitions to HALF_OPEN
- HALF_OPEN allows a single probe; success closes, failure reopens
- All thresholds env-configurable

**Composition**: retry-inside-breaker. The breaker decides whether the call is allowed; only allowed calls enter the retry loop.

**Implementation**: hand-rolled state machine rather than the `opossum` library, for full control over transitions and testability.

## Consequences

**Positive:**
- Transient failures recover automatically; sustained failures fail fast
- HCM is protected from being hammered during an outage
- Breaker state is observable as a gauge metric (TRD §14.2)
- Hand-rolled implementation has no third-party dependency and is fully transparent to test

**Negative:**
- Two mechanisms means two sets of configuration to tune
- The breaker introduces a new failure mode: 503 from the service even though HCM might be available (during cool-down or before probe). Mitigated by short cool-down and HALF_OPEN probe semantics.
- Retry storm at the edge of the breaker tripping (right before OPEN) is possible. Mitigated by counting retry attempts toward the breaker's failure window, so the breaker trips on the actual problem rather than just original calls.
- Hand-rolled breaker has more code to maintain than a library; trades dependency footprint for code volume

## Alternatives Considered

1. **No retry, fail-fast.** Single attempt, propagate error. Rejected: every transient network blip becomes a user-facing failure; degrades reliability significantly without simplifying the design proportionately.

2. **Retry only, no circuit breaker.** Retries handle transients but offer no protection against sustained outages. Rejected: a sustained HCM outage would cause the service to spend its entire HCM call budget retrying every approval, consuming connection-pool slots and saturating the upstream further.

3. **`opossum` library for the circuit breaker.** Battle-tested Node.js circuit breaker. Rejected: introduces a dependency for relatively small state-machine logic; opaque internals are harder to test surgically; the state machine is small enough that owning it is cheaper than depending on it.

4. **Retry + circuit breaker + bulkhead.** Adds isolation through separate connection pools per operation type. Rejected: useful at very high scale but overkill for the current load profile; mentioned as a possible future addition if HCM call volume grows substantially.

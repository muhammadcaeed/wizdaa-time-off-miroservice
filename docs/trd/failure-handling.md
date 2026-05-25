# Failure Handling Implementation

Companion to `TRD.md` §11. The TRD covers the failure-mode catalog, the circuit breaker state machine, the retry policy at the principle level, and the stuck-state sweep concept. This file is the implementer's reference: breaker configuration, per-operation behavior during OPEN, the retry-inside-breaker composition in detail, retry-storm interaction at the breaker edge, and the stuck-state sweep step sequence.

---

## 1. Circuit breaker configuration

Env-driven parameters with defaults:

| Variable | Default | Purpose |
|---|---|---|
| `HCM_BREAKER_FAILURE_THRESHOLD` | 5 | Consecutive failures that trip the breaker |
| `HCM_BREAKER_FAILURE_RATE` | 0.5 | Failure rate in the rolling window that trips the breaker |
| `HCM_BREAKER_WINDOW_SIZE` | 10 | Rolling window size used for failure-rate accounting |
| `HCM_BREAKER_COOLDOWN_MS` | 30000 | Time in OPEN state before transitioning to HALF_OPEN |

The breaker trips on whichever threshold fires first (consecutive count or failure rate). Both are tracked over the same rolling window.

---

## 2. Per-operation behavior during OPEN

When the breaker is OPEN, behavior depends on whether the operation actually calls HCM:

| Operation | Behavior during OPEN |
|---|---|
| Balance read | Unaffected; serves from local cache (no HCM call) |
| Submission, reject, pre-approval cancel | Unaffected; no HCM call |
| Approval, post-approval cancel | Fast-fail with 503 `/errors/hcm-unavailable`. Request stays in its current state. |
| Admin retry (approval, cancellation) | Fast-fail with 503. Admin can retry once the breaker closes. |
| Scheduled reconciliation | Skipped. The job logs `reconciliation.skipped_breaker_open` and waits for the next scheduled cycle. |
| Stuck-state sweep | Skipped for the cycle; stuck rows wait for the next sweep after breaker recovery. |

The breaker's protection is asymmetric by design. Read-path operations stay available because they don't touch HCM; write-path operations fail fast to avoid amplifying a sustained HCM outage with retry storms.

---

## 3. Retry-inside-breaker composition

The breaker wraps the retry loop, not the other way around. The shape:

```
function callHcm(request):
  if breaker.state == OPEN:
    if cooldown_elapsed: breaker.state = HALF_OPEN
    else: throw HcmUnavailableError

  if breaker.state == HALF_OPEN and probe_in_flight:
    throw HcmUnavailableError  # only one probe at a time

  for attempt in 1..max_attempts:
    try:
      response = http.post(request)
      breaker.record_success()
      return response
    catch retryable_error:
      breaker.record_failure()
      if breaker.state == OPEN:
        throw HcmUnavailableError  # breaker tripped mid-retry; abandon
      if attempt < max_attempts:
        wait(backoff_with_jitter(attempt))
    catch non_retryable_error:
      if is_breaker_relevant(error): breaker.record_failure()
      throw  # propagate immediately
  throw RetryExhaustedError
```

Two notes on the composition:

- **Retry failures count toward the breaker.** Each retry attempt that fails records a failure on the breaker's window. This is intentional. The breaker reacts to the actual failure volume rather than to the count of distinct caller intentions. Without this, a single user's exhausted retry budget wouldn't contribute to the breaker's signal at all.
- **Mid-retry breaker trip abandons remaining attempts.** If the breaker opens during a retry loop, the loop terminates immediately rather than completing its remaining attempts against an already-tripped breaker. The caller gets `HcmUnavailableError` instead of `RetryExhaustedError`.

---

## 4. Retry-storm at the breaker edge

In the calls immediately before the breaker trips, every retry attempt counts toward the breaker's failure window. A burst of in-flight callers can each spend their full retry budget against a failing HCM, accelerating the transition to OPEN. This is intentional: the breaker should react to actual load against HCM, not just to the count of distinct callers.

The chaos test for this case asserts that the breaker opens within the expected number of failures when each call is allowed its full retry budget. The test lives at `test/chaos/circuit-breaker-edge.spec.ts` (mapped from REQ-SYNC-06 in `traceability.md` §3).

---

## 5. Stuck-state sweep: step sequence

A scheduled job runs at `STUCK_STATE_SWEEP_INTERVAL_MS` (default 60 seconds). It scans for `TimeOffRequest` rows in `APPROVING` or `CANCELLING` with `updated_at` older than `STUCK_STATE_THRESHOLD_MS` (default 5 minutes).

For each stuck row:

1. **Call HCM with the original idempotency key** (`<id>:decrement` or `<id>:increment`). HCM returns the original outcome: the success response if the original call landed, or a definitive error if it didn't.
2. **HCM confirms success** (2xx with matching arithmetic): commit the saga locally. Update Balance (`total_days -=` or `+=`, `reserved_days -=`), transition to `APPROVED` or `CANCELLED`, emit audit `lifecycle.recovery.committed`.
3. **HCM returns a definitive failure** (4xx, or no record of the key): transition to `APPROVAL_FAILED` or `CANCELLATION_FAILED`, release any held reservation, emit audit `lifecycle.recovery.failed`.
4. **HCM is unreachable or the breaker is OPEN**: skip the row and try again on the next sweep cycle. The row stays in its intermediate state. The sweep doesn't itself trip the breaker further.

The threshold (5 minutes) is chosen to be safely longer than the worst-case HCM round-trip plus the retry budget. A 5-second client timeout × 4 attempts (1 original + 3 retries) with full jitter and a 5-second cap totals roughly 25 seconds at the upper bound, comfortably below the threshold.

The sweep is distinct from scheduled reconciliation: reconciliation refreshes balance totals from HCM, the sweep resolves request-level state.

### 5.1 Sweep configuration

| Variable | Default | Purpose |
|---|---|---|
| `STUCK_STATE_SWEEP_INTERVAL_MS` | 60000 | How often the sweep runs |
| `STUCK_STATE_THRESHOLD_MS` | 300000 | How old a row in APPROVING/CANCELLING has to be before the sweep touches it |

A startup auto-recovery scan (immediate sweep on boot rather than waiting for the first scheduled cycle) is listed as a designed-for extension in TRD §13.4.

---

## 6. Failure interaction summary

A reference of which mechanism handles which failure:

| Failure | Retried? | Counts toward breaker? | Sweep handles it? |
|---|---|---|---|
| F-01 (unreachable) | Yes | Yes | If still stuck post-threshold |
| F-02 (timeout) | Yes | Yes | If still stuck post-threshold |
| F-03 (5xx) | Yes | Yes | If still stuck post-threshold |
| F-04 (ambiguous) | No | Yes | No (point recon handles drift) |
| F-05 (insufficient balance) | No | No | No (point recon handles drift) |
| F-06 (local DB error mid-saga) | Local retry only | No | Yes, if request lands in stuck state |
| F-07 (process crash) | n/a | n/a | Yes (this is what the sweep is for) |
| F-08 (reconciliation drift conflict) | n/a | n/a | No (admin remediation) |

---

## 7. Cross-references

- Failure mode catalog: TRD §11.1
- Circuit breaker state machine: TRD §11.2
- Retry policy principles: TRD §11.3
- Stuck-state sweep concept: TRD §11.4
- Resilience decision (retry + breaker over alternatives): ADR-008
- Idempotency key construction (used by sweep and retries): ADR-007
- R-04 (HCM commit + local fail): TRD §10.3
- Saga shape and compensation: TRD §5, ADR-002

/**
 * Internal HCM failure signals. These are NOT {@link DomainError}s — they don't
 * map directly to HTTP. The saga catches them and decides the request's terminal
 * state and `failure_reason` (TRD §11.1). Each carries a `reason` slug used for
 * `failure_reason` and the audit `hcm.<op>.<outcome>` action.
 *
 * Each {@link HcmError} additionally carries two booleans the resilience policy
 * (ADR-008) reads without instanceof-branching:
 * - `retryable`: whether the retry loop (§11.3) may re-attempt this error.
 * - `countsTowardBreaker`: whether the failure feeds the circuit breaker's
 *   window/consecutive counters (§11.2 "what counts as a failure").
 */
export abstract class HcmError extends Error {
  abstract readonly reason: string;
  /** Whether the retry loop may re-attempt after this error (TRD §11.3). */
  abstract readonly retryable: boolean;
  /** Whether this failure feeds the circuit breaker's counters (TRD §11.2). */
  abstract readonly countsTowardBreaker: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** F-04: 2xx but the response is internally inconsistent (bad total or no correlation id). */
export class HcmArithmeticMismatchError extends HcmError {
  readonly reason = 'hcm_ambiguous';
  // Not retryable: with the same idempotency key HCM returns the identical
  // (still-inconsistent) response, so a retry cannot change the outcome — only
  // point reconciliation can (TRD §11.1 F-04). Still counts toward the breaker:
  // an ambiguous 2xx means HCM is misbehaving even though the HTTP layer succeeded.
  readonly retryable = false;
  readonly countsTowardBreaker = true;

  /** Captured for forensics/audit (TRD §11.1 F-04 metadata); undefined when the response had no usable total. */
  constructor(
    message: string,
    readonly expected?: number,
    readonly actual?: number,
  ) {
    super(message);
  }
}

/** F-05: HCM rejected with insufficient balance after local validation passed. Not retryable. */
export class HcmInsufficientBalanceError extends HcmError {
  readonly reason = 'hcm_insufficient_balance';
  // Domain error, not transient: the balance won't appear on retry, and it is
  // not a sign of HCM ill-health, so it neither retries nor trips the breaker.
  readonly retryable = false;
  readonly countsTowardBreaker = false;
}

/** F-01: network failure (ECONNREFUSED, DNS, unreachable) — the outcome is unknown. */
export class HcmTransportError extends HcmError {
  readonly reason = 'hcm_unreachable';
  readonly retryable = true;
  readonly countsTowardBreaker = true;
}

/** F-02: the request was aborted by the client timeout — HCM may or may not have processed. */
export class HcmTimeoutError extends HcmError {
  readonly reason = 'hcm_timeout';
  readonly retryable = true;
  readonly countsTowardBreaker = true;
}

/** F-03: HCM responded 5xx (or an unparseable body) — retryable server-side failure. */
export class HcmServerError extends HcmError {
  readonly reason = 'hcm_server_error';
  readonly retryable = true;
  readonly countsTowardBreaker = true;
}

/**
 * Circuit breaker fast-fail signal (TRD §11.2 OPEN / HALF_OPEN-busy). Deliberately
 * NOT an {@link HcmError} subclass: the saga's `catch (err instanceof HcmError)`
 * branch maps every HcmError to a terminal `failure_reason`, which would swallow
 * this signal. Keeping it a plain {@link Error} lets it propagate past that branch
 * so the integration step can map it to a 503 `/errors/hcm-unavailable`
 * (REQ-SYNC-06) instead of a misleading per-request failure reason.
 */
export class HcmBreakerOpenError extends Error {
  /** Slug for the eventual 503 problem-detail type. */
  readonly reason = 'hcm_unavailable';

  constructor(message = 'HCM circuit breaker is OPEN; call fast-failed') {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Internal HCM failure signals. These are NOT {@link DomainError}s — they don't
 * map directly to HTTP. The saga catches them and decides the request's terminal
 * state and `failure_reason` (TRD §11.1). Each carries a `reason` slug used for
 * `failure_reason` and the audit `hcm.<op>.<outcome>` action.
 */
export abstract class HcmError extends Error {
  abstract readonly reason: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** F-04: 2xx but the response is internally inconsistent (bad total or no correlation id). */
export class HcmArithmeticMismatchError extends HcmError {
  readonly reason = 'hcm_ambiguous';

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
}

/** F-01/F-02/F-03: network failure, timeout, or 5xx — the outcome is unknown. */
export class HcmTransportError extends HcmError {
  readonly reason = 'hcm_unreachable';
}

import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CircuitBreaker } from './circuit-breaker';
import type { HcmAdjuster } from './hcm-adjuster';
import type { AdjustBalanceInput } from './hcm-client';
import { HcmBreakerOpenError, HcmError } from './hcm.errors';
import type { VerifiedAdjust } from './hcm-response-check';
import { computeBackoffMs, type RetryPolicy, type Rng } from './retry-policy';

/** Injectable sleep so unit tests don't burn real wall-clock seconds. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Resilience decorator (ADR-008): retry-inside-breaker around the real
 * {@link HcmClient}. Slots behind the `HCM_ADJUSTER` token so the saga is
 * untouched. Orchestration only — backoff math lives in `retry-policy`, the FSM
 * in {@link CircuitBreaker}.
 *
 * Flow per call: gate at entry; if not allowed, throw {@link HcmBreakerOpenError}
 * (a non-HcmError so the saga can map it to 503, not a failure_reason). If
 * allowed, run the attempt loop. Each attempt: delegate; on success
 * `recordSuccess`; on a `countsTowardBreaker` error `recordFailure` BEFORE any
 * backoff (so retry-storm at the breaker edge is counted). Retry only while the
 * error is `retryable` and attempts remain; before each retry re-gate — if the
 * breaker has since OPENed, abandon and surface {@link HcmBreakerOpenError}. On
 * exhaustion, surface the LAST error so the saga sets the right failure_reason.
 */
@Injectable()
export class ResilientHcmAdjuster implements HcmAdjuster {
  constructor(
    private readonly delegate: HcmAdjuster,
    private readonly breaker: CircuitBreaker,
    private readonly policy: RetryPolicy,
    private readonly rng: Rng,
    private readonly sleep: Sleep,
    @InjectPinoLogger(ResilientHcmAdjuster.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Adjusts an HCM balance through the breaker + retry policy.
   * @param input the adjustment; its `idempotencyKey` is reused verbatim on every attempt
   * @returns the verified adjust outcome
   * @throws HcmBreakerOpenError when the breaker fast-fails the call (REQ-SYNC-06)
   * @throws HcmError the last delegate error after retries are exhausted (REQ-SYNC-07)
   */
  async adjustBalance(input: AdjustBalanceInput): Promise<VerifiedAdjust> {
    if (!this.breaker.canPass().allowed) {
      throw new HcmBreakerOpenError();
    }

    const totalAttempts = this.policy.maxAttempts + 1;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        const result = await this.delegate.adjustBalance(input);
        this.breaker.recordSuccess();
        return result;
      } catch (err) {
        if (!(err instanceof HcmError)) {
          throw err;
        }
        if (err.countsTowardBreaker) {
          this.breaker.recordFailure();
        } else {
          // A non-counting error (F-05) is a healthy HCM round-trip with a domain
          // answer. recordIgnored() frees a HALF_OPEN probe slot but is a no-op
          // while CLOSED/OPEN — it must NOT credit a success into the window
          // (that would mask genuine HCM ill-health under interleaved F-05s).
          this.breaker.recordIgnored();
        }

        const attemptsRemain = attempt < totalAttempts - 1;
        if (!err.retryable || !attemptsRemain) {
          // Not retryable, or the last attempt: surface this error so the saga
          // sets the right failure_reason (REQ-SYNC-07 exhaustion path).
          throw err;
        }

        // Abandon remaining retries if the breaker opened on this failure.
        if (!this.breaker.canPass().allowed) {
          throw new HcmBreakerOpenError();
        }

        const delayMs = computeBackoffMs(attempt, this.policy.baseMs, this.rng);
        this.logger.info(
          {
            event: 'hcm.retry.attempt',
            idempotencyKey: input.idempotencyKey,
            attempt: attempt + 1,
            nextDelayMs: delayMs,
            reason: err.reason,
          },
          'retrying HCM adjust after retryable failure',
        );
        await this.sleep(delayMs);
      }
    }

    // The loop only exits via return or throw; this satisfies the type checker.
    throw new HcmBreakerOpenError('unreachable: retry loop exited without resolution');
  }
}

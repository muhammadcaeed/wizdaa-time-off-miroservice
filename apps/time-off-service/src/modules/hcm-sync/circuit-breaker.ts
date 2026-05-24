import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

/** Breaker states (TRD §11.2). */
export const BREAKER_STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
} as const;

export type BreakerState = (typeof BREAKER_STATE)[keyof typeof BREAKER_STATE];

/** Size of the rolling outcome window used for the failure-rate trip (TRD §11.2). */
export const BREAKER_WINDOW_SIZE = 10;

/** Tunable breaker thresholds (env-driven at the module boundary). */
export interface CircuitBreakerConfig {
  /** Consecutive failures that trip CLOSED→OPEN. */
  failureThreshold: number;
  /** Failure rate (0..1) over the rolling window that trips CLOSED→OPEN. */
  failureRate: number;
  /** OPEN cool-down before a HALF_OPEN probe is allowed. */
  cooldownMs: number;
  /** Max time a single probe may run before it's treated as failed and re-OPENs. */
  probeDeadlineMs: number;
}

/** Injectable wrapper so tests can advance time without real clocks. */
export type Clock = () => number;

/** Read-only view of the breaker for observability (TRD §14.3 gauge is deferred). */
export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  /** Outcomes in the rolling window, oldest first; `true` = failure. */
  window: readonly boolean[];
  /** Epoch ms at which OPEN→HALF_OPEN becomes allowed, when OPEN. */
  openUntil: number | null;
}

/**
 * Hand-rolled circuit breaker (ADR-008, TRD §11.2). A NestJS singleton so every
 * caller of the HCM seam — the saga today, the sweep/reconciliation later —
 * shares ONE breaker. The decorator gates each attempt through {@link canPass}
 * and reports outcomes via {@link recordSuccess}/{@link recordFailure}.
 *
 * The HALF_OPEN→probe transition is a synchronous read-then-write within a single
 * Node tick, which IS the atomic CAS here: Node's event loop guarantees no other
 * callback interleaves between the read and the write, so a Mutex is unnecessary.
 */
@Injectable()
export class CircuitBreaker {
  private state: BreakerState = BREAKER_STATE.CLOSED;
  private consecutiveFailures = 0;
  private readonly window: boolean[] = [];
  /** Epoch ms when OPEN cool-down expires; HALF_OPEN becomes reachable after. */
  private openUntil = 0;
  /** Epoch-ms deadline by which an in-flight HALF_OPEN probe must report back. */
  private probeDeadline = 0;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly now: Clock,
    @InjectPinoLogger(CircuitBreaker.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Decides whether a call may proceed and atomically claims the HALF_OPEN probe
   * slot when the cool-down has elapsed.
   * @returns `{ allowed: true }` to proceed, `{ allowed: false }` to fast-fail
   */
  canPass(): { allowed: boolean } {
    const t = this.now();

    if (this.state === BREAKER_STATE.CLOSED) {
      return { allowed: true };
    }

    if (this.state === BREAKER_STATE.OPEN) {
      if (t >= this.openUntil) {
        // Cool-down elapsed: claim the single probe slot in this same tick.
        this.transition(BREAKER_STATE.HALF_OPEN, 'cooldown_elapsed');
        this.probeDeadline = t + this.config.probeDeadlineMs;
        return { allowed: true };
      }
      return { allowed: false };
    }

    // HALF_OPEN: a probe is in flight. Re-OPEN if it wedged past its deadline,
    // otherwise fast-fail concurrent callers (predictable latency over recovery).
    if (t >= this.probeDeadline) {
      this.openFrom('probe_deadline_exceeded');
      return { allowed: false };
    }
    return { allowed: false };
  }

  /**
   * Records a successful call. A success while HALF_OPEN closes the breaker and
   * resets the window + consecutive counter (pre-OPEN history is not carried).
   */
  recordSuccess(): void {
    if (this.state === BREAKER_STATE.HALF_OPEN) {
      this.reset();
      this.transition(BREAKER_STATE.CLOSED, 'probe_succeeded');
      return;
    }
    this.consecutiveFailures = 0;
    this.push(false);
  }

  /**
   * Records a failing call (only errors with `countsTowardBreaker` reach here).
   * A failure while HALF_OPEN re-OPENs and restarts cool-down; while CLOSED it
   * may trip the breaker on consecutive count or window failure rate.
   */
  recordFailure(): void {
    if (this.state === BREAKER_STATE.HALF_OPEN) {
      this.openFrom('probe_failed');
      return;
    }
    this.consecutiveFailures += 1;
    this.push(true);
    if (this.shouldTrip()) {
      this.openFrom('threshold_reached');
    }
  }

  /** @returns an immutable snapshot of breaker state for observability. */
  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      window: [...this.window],
      openUntil: this.state === BREAKER_STATE.OPEN ? this.openUntil : null,
    };
  }

  private shouldTrip(): boolean {
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      return true;
    }
    if (this.window.length < BREAKER_WINDOW_SIZE) {
      return false;
    }
    const failures = this.window.filter((failed) => failed).length;
    return failures / this.window.length > this.config.failureRate;
  }

  private openFrom(cause: string): void {
    this.openUntil = this.now() + this.config.cooldownMs;
    this.transition(BREAKER_STATE.OPEN, cause);
  }

  private reset(): void {
    this.consecutiveFailures = 0;
    this.window.length = 0;
  }

  private push(failed: boolean): void {
    this.window.push(failed);
    if (this.window.length > BREAKER_WINDOW_SIZE) {
      this.window.shift();
    }
  }

  private transition(to: BreakerState, cause: string): void {
    const from = this.state;
    this.state = to;
    if (from !== to) {
      this.logger.info(
        { event: 'hcm.breaker.transition', from, to, cause },
        'HCM breaker state change',
      );
    }
  }
}

import type { PinoLogger } from 'nestjs-pino';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker';
import type { HcmAdjuster } from './hcm-adjuster';
import type { AdjustBalanceInput } from './hcm-client';
import {
  HcmArithmeticMismatchError,
  HcmBreakerOpenError,
  HcmInsufficientBalanceError,
  HcmServerError,
} from './hcm.errors';
import type { VerifiedAdjust } from './hcm-response-check';
import { ResilientHcmAdjuster } from './resilient-hcm-adjuster';
import type { RetryPolicy } from './retry-policy';

const POLICY: RetryPolicy = { maxAttempts: 3, baseMs: 100 };
const BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureRate: 0.5,
  cooldownMs: 30_000,
  probeDeadlineMs: 10_000,
};

const OK: VerifiedAdjust = { newTotalDays: 15, correlationId: 'hcm_op_1' };

function fakeLogger(): PinoLogger {
  return { info: () => undefined } as unknown as PinoLogger;
}

/** Records inputs and replays a scripted sequence of outcomes. */
class FakeAdjuster implements HcmAdjuster {
  readonly calls: AdjustBalanceInput[] = [];
  constructor(private readonly outcomes: (VerifiedAdjust | Error)[]) {}
  adjustBalance(input: AdjustBalanceInput): Promise<VerifiedAdjust> {
    this.calls.push(input);
    const outcome = this.outcomes[this.calls.length - 1];
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  }
}

function makeInput(): AdjustBalanceInput {
  return {
    employeeId: 'emp1',
    locationId: 'loc1',
    delta: -5,
    idempotencyKey: 'req1:decrement',
    expectedPreTotal: 20,
    sourceReference: 'request:req1',
  };
}

function build(fake: HcmAdjuster, breaker: CircuitBreaker): ResilientHcmAdjuster {
  // Deterministic rng (mid jitter) + no-op sleep so tests don't wait.
  return new ResilientHcmAdjuster(
    fake,
    breaker,
    POLICY,
    () => 0.5,
    () => Promise.resolve(),
    fakeLogger(),
  );
}

function makeBreaker(): CircuitBreaker {
  return new CircuitBreaker(BREAKER_CONFIG, () => 0, fakeLogger());
}

/**
 * @req REQ-SYNC-06
 * @req REQ-SYNC-07
 */
describe('ResilientHcmAdjuster (retry-inside-breaker, ADR-008)', () => {
  it('recovers a single transient F-03 then success: no failure surfaced, breaker not tripped', async () => {
    const fake = new FakeAdjuster([new HcmServerError('503'), OK]);
    const breaker = makeBreaker();
    const result = await build(fake, breaker).adjustBalance(makeInput());

    expect(result).toEqual(OK);
    expect(fake.calls).toHaveLength(2);
    expect(breaker.snapshot().state).toBe('CLOSED');
    // One failure then a success; the success resets consecutive to 0.
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('exhausts retries on 4 consecutive F-03: surfaces last error, counts all attempts in the breaker', async () => {
    const fake = new FakeAdjuster([
      new HcmServerError('1'),
      new HcmServerError('2'),
      new HcmServerError('3'),
      new HcmServerError('4'),
    ]);
    const breaker = makeBreaker();

    await expect(build(fake, breaker).adjustBalance(makeInput())).rejects.toBeInstanceOf(
      HcmServerError,
    );
    expect(fake.calls).toHaveLength(4); // original + 3 retries
    // Per-attempt counting: 4 failures in the window (TRD §11.3 retry storm).
    expect(breaker.snapshot().window.filter(Boolean)).toHaveLength(4);
  });

  it('F-05 insufficient balance: no retry, no breaker failure recorded', async () => {
    const fake = new FakeAdjuster([new HcmInsufficientBalanceError('409')]);
    const breaker = makeBreaker();

    await expect(build(fake, breaker).adjustBalance(makeInput())).rejects.toBeInstanceOf(
      HcmInsufficientBalanceError,
    );
    expect(fake.calls).toHaveLength(1);
    // HCM responded healthily (domain reject), so it counts as a success outcome,
    // not a breaker failure — consecutive stays 0 and no failure enters the window.
    expect(breaker.snapshot().window).toEqual([false]);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('F-05 during a HALF_OPEN probe resolves the probe to CLOSED (no wedge)', async () => {
    const clock = { t: 0 };
    const breaker = new CircuitBreaker(BREAKER_CONFIG, () => clock.t, fakeLogger());
    for (let i = 0; i < 5; i++) breaker.recordFailure(); // OPEN
    clock.t += BREAKER_CONFIG.cooldownMs; // cool-down elapsed; entry gate claims the probe
    const fake = new FakeAdjuster([new HcmInsufficientBalanceError('409')]);

    await expect(build(fake, breaker).adjustBalance(makeInput())).rejects.toBeInstanceOf(
      HcmInsufficientBalanceError,
    );
    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('F-04 ambiguous: no retry, breaker incremented', async () => {
    const fake = new FakeAdjuster([new HcmArithmeticMismatchError('bad total')]);
    const breaker = makeBreaker();

    await expect(build(fake, breaker).adjustBalance(makeInput())).rejects.toBeInstanceOf(
      HcmArithmeticMismatchError,
    );
    expect(fake.calls).toHaveLength(1);
    expect(breaker.snapshot().window).toEqual([true]);
  });

  it('breaker opens mid-retry: abandons remaining attempts, surfaces HcmBreakerOpenError', async () => {
    // Threshold 5; original + 4 retries would be 5 attempts. The 5th failure
    // trips the breaker, so the next gate fast-fails before a 6th attempt.
    const policy: RetryPolicy = { maxAttempts: 6, baseMs: 100 };
    const fake = new FakeAdjuster(Array.from({ length: 7 }, (_, i) => new HcmServerError(`${i}`)));
    const breaker = makeBreaker();
    const adjuster = new ResilientHcmAdjuster(
      fake,
      breaker,
      policy,
      () => 0.5,
      () => Promise.resolve(),
      fakeLogger(),
    );

    await expect(adjuster.adjustBalance(makeInput())).rejects.toBeInstanceOf(HcmBreakerOpenError);
    // 5 attempts trip the breaker (consecutive threshold); 6th is abandoned.
    expect(fake.calls).toHaveLength(5);
    expect(breaker.snapshot().state).toBe('OPEN');
  });

  it('breaker already OPEN at entry: fast-fails without calling the delegate', async () => {
    const breaker = makeBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure(); // trip it
    const fake = new FakeAdjuster([OK]);

    await expect(build(fake, breaker).adjustBalance(makeInput())).rejects.toBeInstanceOf(
      HcmBreakerOpenError,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('reuses the original idempotency key verbatim on every attempt', async () => {
    const fake = new FakeAdjuster([new HcmServerError('1'), new HcmServerError('2'), OK]);
    const breaker = makeBreaker();
    await build(fake, breaker).adjustBalance(makeInput());

    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) {
      expect(call.idempotencyKey).toBe('req1:decrement');
    }
  });
});

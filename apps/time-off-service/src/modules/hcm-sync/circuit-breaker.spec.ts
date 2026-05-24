import type { PinoLogger } from 'nestjs-pino';
import {
  BREAKER_STATE,
  BREAKER_WINDOW_SIZE,
  CircuitBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker';

const CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureRate: 0.5,
  cooldownMs: 30_000,
  probeDeadlineMs: 10_000,
};

/** Minimal PinoLogger stand-in; the breaker only calls `.info`. */
function fakeLogger(): PinoLogger {
  return { info: () => undefined } as unknown as PinoLogger;
}

function makeBreaker(clock: { t: number }): CircuitBreaker {
  return new CircuitBreaker(CONFIG, () => clock.t, fakeLogger());
}

/**
 * @req REQ-SYNC-06
 */
describe('CircuitBreaker FSM (TRD §11.2)', () => {
  it('starts CLOSED and lets calls pass', () => {
    const b = makeBreaker({ t: 0 });
    expect(b.snapshot().state).toBe(BREAKER_STATE.CLOSED);
    expect(b.canPass().allowed).toBe(true);
  });

  it('trips OPEN on 5 consecutive failures', () => {
    const clock = { t: 0 };
    const b = makeBreaker(clock);
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.snapshot().state).toBe(BREAKER_STATE.CLOSED);
    b.recordFailure();
    expect(b.snapshot().state).toBe(BREAKER_STATE.OPEN);
    expect(b.canPass().allowed).toBe(false);
  });

  it('a success resets the consecutive counter (4 fails then success then 4 fails stays CLOSED)', () => {
    const b = makeBreaker({ t: 0 });
    for (let i = 0; i < 4; i++) b.recordFailure();
    b.recordSuccess();
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.snapshot().state).toBe(BREAKER_STATE.CLOSED);
  });

  it('trips OPEN on >50% failure rate over a full window of 10', () => {
    const b = makeBreaker({ t: 0 });
    // 6 failures, 4 successes interleaved so consecutive never hits 5.
    const pattern = [true, false, true, false, true, false, true, false, true, true];
    expect(pattern.filter(Boolean).length).toBe(6);
    expect(pattern.length).toBe(BREAKER_WINDOW_SIZE);
    pattern.forEach((failed) => (failed ? b.recordFailure() : b.recordSuccess()));
    expect(b.snapshot().state).toBe(BREAKER_STATE.OPEN);
  });

  it('OPEN fast-fails until cool-down, then HALF_OPEN allows exactly one probe', () => {
    const clock = { t: 1000 };
    const b = makeBreaker(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    expect(b.canPass().allowed).toBe(false);

    clock.t += CONFIG.cooldownMs - 1;
    expect(b.canPass().allowed).toBe(false);

    clock.t += 1; // cool-down elapsed
    expect(b.canPass().allowed).toBe(true); // probe claimed
    expect(b.snapshot().state).toBe(BREAKER_STATE.HALF_OPEN);
    expect(b.canPass().allowed).toBe(false); // concurrent caller fast-fails
  });

  it('probe success → CLOSED and resets window + consecutive counter', () => {
    const clock = { t: 0 };
    const b = makeBreaker(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    clock.t += CONFIG.cooldownMs;
    b.canPass(); // claim probe
    b.recordSuccess();
    const snap = b.snapshot();
    expect(snap.state).toBe(BREAKER_STATE.CLOSED);
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.window).toEqual([]);
  });

  it('probe failure → OPEN with cool-down restarted from now', () => {
    const clock = { t: 0 };
    const b = makeBreaker(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    clock.t += CONFIG.cooldownMs;
    b.canPass(); // claim probe at t = cooldown
    b.recordFailure(); // probe fails
    expect(b.snapshot().state).toBe(BREAKER_STATE.OPEN);
    expect(b.snapshot().openUntil).toBe(clock.t + CONFIG.cooldownMs);
  });

  it('a wedged probe past its deadline re-OPENs and restarts cool-down', () => {
    const clock = { t: 0 };
    const b = makeBreaker(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    clock.t += CONFIG.cooldownMs;
    expect(b.canPass().allowed).toBe(true); // probe claimed, never reports back
    clock.t += CONFIG.probeDeadlineMs; // deadline reached
    expect(b.canPass().allowed).toBe(false);
    expect(b.snapshot().state).toBe(BREAKER_STATE.OPEN);
    expect(b.snapshot().openUntil).toBe(clock.t + CONFIG.cooldownMs);
  });
});

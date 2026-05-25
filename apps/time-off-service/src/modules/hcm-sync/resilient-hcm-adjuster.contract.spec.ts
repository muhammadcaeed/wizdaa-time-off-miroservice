import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { Server } from 'node:http';
import { MockHcmModule } from '../../../../mock-hcm/src/mock-hcm.module';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker';
import { HcmClient, type AdjustBalanceInput } from './hcm-client';
import { HcmBreakerOpenError, HcmServerError, HcmTransportError } from './hcm.errors';
import { ResilientHcmAdjuster } from './resilient-hcm-adjuster';
import type { RetryPolicy } from './retry-policy';

const BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureRate: 0.5,
  cooldownMs: 30_000,
  probeDeadlineMs: 10_000,
};
const POLICY: RetryPolicy = { maxAttempts: 3, baseMs: 1 };

function fakeLogger(): PinoLogger {
  return { info: () => undefined } as unknown as PinoLogger;
}

interface CallEntry {
  path: string;
  headers: { 'idempotency-key'?: string };
}

/**
 * Contract layer: the real {@link ResilientHcmAdjuster} (retry-inside-breaker)
 * driving the real {@link HcmClient} over HTTP against the in-process mock HCM.
 * Proves the wiring retries over real sockets with a stable idempotency key, and
 * that the breaker fast-fails without touching HCM. (Recover-on-retry and the
 * HALF_OPEN probe are unit-covered in resilient-hcm-adjuster.spec.ts /
 * circuit-breaker.spec.ts with an injected clock; the mock's deterministic
 * `flaky` cannot express a fail-first-then-succeed sequence.)
 *
 * @req REQ-SYNC-06
 * @req REQ-SYNC-07
 * @req REQ-DEF-07
 */
describe('ResilientHcmAdjuster (contract against mock HCM)', () => {
  let mock: INestApplication;
  let adjuster: ResilientHcmAdjuster;
  let breaker: CircuitBreaker;

  const EMP = 'emp_r01';
  const LOC = 'loc_r01';

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/reset')
      .expect(201);
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/balances')
      .send({ employee_id: EMP, location_id: LOC, total_days: 20 });
    breaker = new CircuitBreaker(BREAKER_CONFIG, Date.now, fakeLogger());
    const client = new HcmClient(await mock.getUrl(), 1000);
    // Immediate sleep so backoff doesn't burn real wall-clock time.
    adjuster = new ResilientHcmAdjuster(
      client,
      breaker,
      POLICY,
      () => 0.5,
      async () => {},
      fakeLogger(),
    );
  });

  function input(reqId: string): AdjustBalanceInput {
    return {
      employeeId: EMP,
      locationId: LOC,
      delta: -5,
      idempotencyKey: `${reqId}:decrement`,
      expectedPreTotal: 20,
      sourceReference: `request:${reqId}`,
    };
  }

  async function adjustCalls(): Promise<CallEntry[]> {
    const res = await request(mock.getHttpServer() as Server)
      .get('/mock/control/calls')
      .expect(200);
    const body = res.body as { calls: CallEntry[] };
    return body.calls.filter((c) => c.path.includes('/hcm/balances/adjust'));
  }

  it('retries a 5xx (F-03) up to the budget reusing the original key, then surfaces HcmServerError', async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'down' } });

    await expect(adjuster.adjustBalance(input('req_r1'))).rejects.toBeInstanceOf(HcmServerError);

    const calls = await adjustCalls();
    expect(calls).toHaveLength(POLICY.maxAttempts + 1); // original + 3 retries
    expect(calls.every((c) => c.headers['idempotency-key'] === 'req_r1:decrement')).toBe(true);
  });

  it('retries a transport failure (F-01) then surfaces HcmTransportError on exhaustion', async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'network-failure' } });

    await expect(adjuster.adjustBalance(input('req_r2'))).rejects.toBeInstanceOf(HcmTransportError);
    expect((await adjustCalls()).length).toBeGreaterThan(1);
  });

  it('fast-fails with HcmBreakerOpenError once OPEN, without contacting HCM (REQ-SYNC-06)', async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'down' } });

    // Two exhausting calls (4 failures each) cross the 5-consecutive threshold.
    await expect(adjuster.adjustBalance(input('req_r3'))).rejects.toBeInstanceOf(HcmServerError);
    await expect(adjuster.adjustBalance(input('req_r4'))).rejects.toBeInstanceOf(
      HcmBreakerOpenError,
    );
    expect(breaker.snapshot().state).toBe('OPEN');

    const before = (await adjustCalls()).length;
    await expect(adjuster.adjustBalance(input('req_r5'))).rejects.toBeInstanceOf(
      HcmBreakerOpenError,
    );
    expect((await adjustCalls()).length).toBe(before); // no new HCM contact
  });
});

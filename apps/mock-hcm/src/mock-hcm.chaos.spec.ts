import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import { MockHcmModule } from './mock-hcm.module';

interface AdjustBody {
  employee_id: string;
  location_id: string;
  new_total_days: number;
  hcm_correlation_id: string;
  timestamp: string;
}
interface CallsBody {
  calls: {
    method: string;
    path: string;
    body: unknown;
    headers: { 'idempotency-key'?: string };
    status: number;
    transport_error?: boolean;
    timestamp: string;
  }[];
}

/** Reads a supertest response body as a known shape (body is otherwise `any`). */
function body<T>(res: Response): T {
  return res.body as T;
}

const adjustBody = {
  employee_id: 'emp_001',
  location_id: 'loc_001',
  delta: -5,
  operation_type: 'DECREMENT',
  source_reference: 'request:req_1',
};

/**
 * Chaos-layer behavior of the mock (mock-hcm.md §4, §3.6). Drives the new
 * failure-injection scenarios and the call log over a REAL HTTP socket
 * (`listen(0)` + native fetch) so transport-level failures surface as the
 * service's HCM client would observe them.
 */
describe('Mock HCM (chaos scenarios)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MockHcmModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await request(app.getHttpServer()).post('/mock/control/reset').expect(201);
  });

  async function setScenario(scenario: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: scenario } })
      .expect(201);
  }

  describe('slow', () => {
    it('delays the response by the per-request latency_ms override', async () => {
      await setScenario('slow');
      const start = Date.now();
      const res = await request(app.getHttpServer())
        .post('/hcm/balances/adjust?latency_ms=150')
        .set('Idempotency-Key', 'k-slow')
        .send(adjustBody)
        .expect(200);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(body<AdjustBody>(res).new_total_days).toBe(15);
    });
  });

  describe('down', () => {
    it('returns 503 on every call', async () => {
      await setScenario('down');
      for (const key of ['d1', 'd2', 'd3']) {
        await request(app.getHttpServer())
          .post('/hcm/balances/adjust')
          .set('Idempotency-Key', key)
          .send(adjustBody)
          .expect(503);
      }
    });
  });

  describe('flaky', () => {
    it('fails deterministically then recovers when flipped back to normal', async () => {
      // fail_rate=0.5 → every 2nd call fails (counter-based, deterministic).
      await setScenario('flaky');

      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await request(app.getHttpServer())
          .post('/hcm/balances/adjust?fail_rate=0.5')
          .set('Idempotency-Key', `f-${i}`)
          .send(adjustBody);
        statuses.push(res.status);
      }
      // Deterministic alternation: success, fail, success, fail (or its mirror).
      const failures = statuses.filter((s) => s >= 500).length;
      const successes = statuses.filter((s) => s === 200).length;
      expect(failures).toBe(2);
      expect(successes).toBe(2);

      // A retry with the same key succeeds once the scenario is normal again.
      await request(app.getHttpServer()).post('/mock/control/reset').expect(201);
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'f-recovered')
        .send(adjustBody)
        .expect(200);
    });

    it('does not poison the idempotency cache: a failed key succeeds on retry once flipped to normal (no reset)', async () => {
      // Failures occur BEFORE a response is stored, so the same key is free to
      // succeed once the scenario flips. A later global assignment wins in
      // ScenarioService.resolve (specificity >= best), so no reset is needed.
      await setScenario('down');
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'no-poison')
        .send(adjustBody)
        .expect(503);

      await setScenario('normal');
      const res = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'no-poison')
        .send(adjustBody)
        .expect(200);
      expect(body<AdjustBody>(res).new_total_days).toBe(15);
    });
  });

  describe('network-failure', () => {
    it('destroys the socket so a real HTTP client sees a transport error', async () => {
      await setScenario('network-failure');

      await expect(
        fetch(`${baseUrl}/hcm/balances/adjust`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'nf-1' },
          body: JSON.stringify(adjustBody),
        }),
      ).rejects.toThrow();

      // The failed attempt is still logged with transport_error + the key it sent.
      const res = await request(app.getHttpServer()).get('/mock/control/calls').expect(200);
      const adjust = body<CallsBody>(res).calls.find((c) =>
        c.path.startsWith('/hcm/balances/adjust'),
      );
      expect(adjust?.transport_error).toBe(true);
      expect(adjust?.status).toBe(0);
      expect(adjust?.headers['idempotency-key']).toBe('nf-1');
    });
  });

  describe('GET /mock/control/calls', () => {
    it('records method, path, idempotency-key, and status for HCM-surface calls', async () => {
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'log-1')
        .send(adjustBody)
        .expect(200);

      const res = await request(app.getHttpServer()).get('/mock/control/calls').expect(200);
      const calls = body<CallsBody>(res).calls;
      const adjust = calls.find((c) => c.path.startsWith('/hcm/balances/adjust'));
      expect(adjust).toBeDefined();
      expect(adjust?.method).toBe('POST');
      expect(adjust?.headers['idempotency-key']).toBe('log-1');
      expect(adjust?.status).toBe(200);
      expect(adjust?.timestamp).toBeTruthy();
    });

    it('does not record control-plane calls', async () => {
      const res = await request(app.getHttpServer()).get('/mock/control/calls').expect(200);
      const calls = body<CallsBody>(res).calls;
      expect(calls.every((c) => !c.path.startsWith('/mock/control'))).toBe(true);
    });

    it('records the same idempotency-key across repeated attempts under down', async () => {
      await setScenario('down');
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'retry-key')
        .send(adjustBody)
        .expect(503);
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'retry-key')
        .send(adjustBody)
        .expect(503);

      const res = await request(app.getHttpServer()).get('/mock/control/calls').expect(200);
      const adjusts = body<CallsBody>(res).calls.filter((c) =>
        c.path.startsWith('/hcm/balances/adjust'),
      );
      expect(adjusts).toHaveLength(2);
      expect(adjusts.every((c) => c.headers['idempotency-key'] === 'retry-key')).toBe(true);
      expect(adjusts.every((c) => c.status === 503)).toBe(true);
    });

    it('is cleared by reset', async () => {
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'log-clear')
        .send(adjustBody)
        .expect(200);
      await request(app.getHttpServer()).post('/mock/control/reset').expect(201);

      const res = await request(app.getHttpServer()).get('/mock/control/calls').expect(200);
      expect(body<CallsBody>(res).calls).toEqual([]);
    });
  });
});

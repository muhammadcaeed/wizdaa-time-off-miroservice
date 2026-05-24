import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import { MockHcmModule } from './mock-hcm.module';

interface BalancesBody {
  employee_id: string;
  balances: { location_id: string; total_days: number; last_modified_at: string }[];
}
interface AdjustBody {
  employee_id: string;
  location_id: string;
  new_total_days: number;
  hcm_correlation_id: string;
  timestamp: string;
}
interface StateBody {
  scenarios: unknown[];
  storage: { employee_id: string; total_days: number }[];
  idempotencyKeys: string[];
}

/** Reads a supertest response body as a known shape (body is otherwise `any`). */
function body<T>(res: Response): T {
  return res.body as T;
}

/**
 * HTTP-level behavior of the mock (mock-hcm.md §2, §3, §6). Proves the public
 * surface and control plane wire together in-process: GET balances, adjust
 * under each cycle-02 scenario, idempotency replay/conflict, reset re-seeding.
 */
describe('Mock HCM (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MockHcmModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await request(app.getHttpServer()).post('/mock/control/reset').expect(201);
  });

  const adjustBody = {
    employee_id: 'emp_001',
    location_id: 'loc_001',
    delta: -5,
    operation_type: 'DECREMENT',
    source_reference: 'request:req_1',
  };

  describe('GET /hcm/balances/:employee_id', () => {
    it('returns 200 with all balances for a known employee', async () => {
      const res = await request(app.getHttpServer()).get('/hcm/balances/emp_001').expect(200);

      expect(body<BalancesBody>(res)).toEqual({
        employee_id: 'emp_001',
        balances: [
          { location_id: 'loc_001', total_days: 20, last_modified_at: '2026-01-01T00:00:00Z' },
        ],
      });
    });

    it('returns 404 for an unknown employee', async () => {
      await request(app.getHttpServer()).get('/hcm/balances/nobody').expect(404);
    });
  });

  describe('POST /hcm/balances/adjust', () => {
    it('applies the delta and returns the new total under normal', async () => {
      const res = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'req_1:decrement')
        .send(adjustBody)
        .expect(200);

      expect(body<AdjustBody>(res).new_total_days).toBe(15);
      expect(body<AdjustBody>(res).hcm_correlation_id).toBeTruthy();
      expect(body<AdjustBody>(res).employee_id).toBe('emp_001');

      const after = await request(app.getHttpServer()).get('/hcm/balances/emp_001').expect(200);
      expect(body<BalancesBody>(after).balances[0].total_days).toBe(15);
    });

    it('returns 404 for an unknown (employee, location) pair', async () => {
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k')
        .send({ ...adjustBody, location_id: 'loc_999' })
        .expect(404);
    });

    it('rejects an extra field via the validation pipe', async () => {
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k')
        .send({ ...adjustBody, surprise: true })
        .expect(400);
    });

    it('replays the original response verbatim for a duplicate key + body', async () => {
      const first = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'req_1:decrement')
        .send(adjustBody)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'req_1:decrement')
        .send(adjustBody)
        .expect(200);

      expect(body<AdjustBody>(second)).toEqual(body<AdjustBody>(first));

      const after = await request(app.getHttpServer()).get('/hcm/balances/emp_001').expect(200);
      expect(body<BalancesBody>(after).balances[0].total_days).toBe(15);
    });

    it('returns 409 for a duplicate key with a different body', async () => {
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'req_1:decrement')
        .send(adjustBody)
        .expect(200);

      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'req_1:decrement')
        .send({ ...adjustBody, delta: -6 })
        .expect(409);
    });

    it('under ambiguous-success returns 200 with the unchanged pre-total and does not mutate storage', async () => {
      await request(app.getHttpServer())
        .post('/mock/control/scenarios')
        .send({ endpoints: { adjust: 'ambiguous-success' } })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k')
        .send(adjustBody)
        .expect(200);

      expect(body<AdjustBody>(res).new_total_days).toBe(20);

      const after = await request(app.getHttpServer()).get('/hcm/balances/emp_001').expect(200);
      expect(body<BalancesBody>(after).balances[0].total_days).toBe(20);
    });

    it('under unverifiable-success returns a mismatching total and a stale GET', async () => {
      await request(app.getHttpServer())
        .post('/mock/control/scenarios')
        .send({ endpoints: { adjust: 'unverifiable-success' } })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k')
        .send(adjustBody)
        .expect(200);

      expect(body<AdjustBody>(res).new_total_days).toBe(16);

      const after = await request(app.getHttpServer()).get('/hcm/balances/emp_001').expect(200);
      expect(body<BalancesBody>(after).balances[0].total_days).toBe(20);
    });

    it('honors a scoped scenario only for the matching pair', async () => {
      await request(app.getHttpServer())
        .post('/mock/control/scenarios')
        .send({ endpoints: { adjust: 'ambiguous-success' }, scope: { employee_id: 'emp_001' } })
        .expect(201);

      const scoped = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k1')
        .send(adjustBody)
        .expect(200);
      expect(body<AdjustBody>(scoped).new_total_days).toBe(20);

      const other = await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k2')
        .send({ ...adjustBody, employee_id: 'emp_002', source_reference: 'request:req_2' })
        .expect(200);
      expect(body<AdjustBody>(other).new_total_days).toBe(10);
    });
  });

  describe('control plane', () => {
    it('injects a balance via POST /mock/control/balances', async () => {
      await request(app.getHttpServer())
        .post('/mock/control/balances')
        .send({ employee_id: 'emp_777', location_id: 'loc_777', total_days: 42 })
        .expect(201);

      const res = await request(app.getHttpServer()).get('/hcm/balances/emp_777').expect(200);
      expect(body<BalancesBody>(res).balances[0].total_days).toBe(42);
    });

    it('reset re-seeds storage and clears the idempotency cache', async () => {
      await request(app.getHttpServer())
        .post('/hcm/balances/adjust')
        .set('Idempotency-Key', 'k')
        .send(adjustBody)
        .expect(200);

      await request(app.getHttpServer()).post('/mock/control/reset').expect(201);

      const state = body<StateBody>(
        await request(app.getHttpServer()).get('/mock/control/state').expect(200),
      );
      expect(state.idempotencyKeys).toEqual([]);
      const seeded = state.storage.find((r) => r.employee_id === 'emp_001');
      expect(seeded?.total_days).toBe(20);
    });

    it('exposes scenarios, storage, and idempotency keys via GET /mock/control/state', async () => {
      await request(app.getHttpServer())
        .post('/mock/control/scenarios')
        .send({ endpoints: { adjust: 'ambiguous-success' } })
        .expect(201);

      const state = body<StateBody>(
        await request(app.getHttpServer()).get('/mock/control/state').expect(200),
      );
      expect(state.scenarios).toHaveLength(1);
      expect(Array.isArray(state.storage)).toBe(true);
    });
  });
});

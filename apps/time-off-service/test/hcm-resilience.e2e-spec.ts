import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { Balance, Employee, Location, TimeOffRequest } from '../src/database/entities';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';

/**
 * Full approval saga over HTTP through the REAL resilience stack (retry +
 * shared circuit breaker) against the mock HCM in `down` mode. Proves the
 * breaker trips, the entry pre-gate fast-fails with 503 while leaving the
 * request non-transient, and the breaker state is observable to admins.
 *
 * @req REQ-SYNC-06
 * @req REQ-DEF-07
 */
describe('HCM resilience (e2e): retry exhaustion, breaker trip, 503 fast-fail', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  const EMPS = ['emp_a', 'emp_b', 'emp_c'] as const;

  // Short cool-down so the recovery test can wait out OPEN→HALF_OPEN without a
  // 30s pause; the trip→fast-fail assertions run in microseconds, well inside it.
  const COOLDOWN_MS = 500;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmBaseUrl: await mock.getUrl(), breakerCooldownMs: COOLDOWN_MS });

    await ctx.dataSource
      .getRepository(Location)
      .insert({ id: 'loc_001', name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: 'mgr_001',
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: 'loc_001',
      managerId: null,
    });
    for (const emp of EMPS) {
      await ctx.dataSource.getRepository(Employee).insert({
        id: emp,
        email: `${emp}@x.io`,
        firstName: 'E',
        lastName: 'O',
        locationId: 'loc_001',
        managerId: 'mgr_001',
      });
      await ctx.dataSource.getRepository(Balance).insert({
        id: `bal_${emp}`,
        employeeId: emp,
        locationId: 'loc_001',
        totalDays: 10,
        reservedDays: 3,
        version: 0,
      });
      await ctx.dataSource.getRepository(TimeOffRequest).insert({
        id: `req_${emp}`,
        employeeId: emp,
        locationId: 'loc_001',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: 3,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      });
      await request(mock.getHttpServer() as Server)
        .post('/mock/control/balances')
        .send({ employee_id: emp, location_id: 'loc_001', total_days: 10 });
    }

    // HCM is hard-down for every adjust.
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'down' } });
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const approve = (emp: string, sub = 'mgr_001', roles: ('MANAGER' | 'ADMIN')[] = ['MANAGER']) =>
    request(ctx.httpServer)
      .post(`/api/v1/requests/req_${emp}/approve`)
      .set('Authorization', bearer(sub, roles))
      .set('Idempotency-Key', randomUUID());

  async function adjustCallCount(): Promise<number> {
    const res = await request(mock.getHttpServer() as Server)
      .get('/mock/control/calls')
      .expect(200);
    const body = res.body as { calls: { path: string }[] };
    return body.calls.filter((c) => c.path.includes('/hcm/balances/adjust')).length;
  }

  it('runs the full retry budget then fails the request with hcm_server_error (F-03, REQ-DEF-07)', async () => {
    const before = await adjustCallCount();
    const res = await approve('emp_a').expect(202);
    const body = res.body as RequestResponse;

    expect(body.status).toBe('APPROVAL_FAILED');
    expect(body.failure_reason).toBe('hcm_server_error');
    expect((await adjustCallCount()) - before).toBe(4); // original + 3 retries
  });

  it('trips the breaker, then fast-fails subsequent approvals with 503 leaving them SUBMITTED', async () => {
    // emp_b's first attempt crosses the 5-consecutive threshold and opens the
    // breaker mid-flight → APPROVAL_FAILED (cannot roll APPROVING back).
    const tripped = await approve('emp_b').expect(202);
    expect((tripped.body as RequestResponse).status).toBe('APPROVAL_FAILED');

    // emp_c: breaker is OPEN at entry → 503 BEFORE any state change, no HCM call.
    const before = await adjustCallCount();
    await approve('emp_c').expect(503);
    expect(await adjustCallCount()).toBe(before); // breaker spared HCM

    const reqC = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_emp_c' });
    expect(reqC.status).toBe('SUBMITTED'); // never entered a transient state
  });

  it('exposes breaker state to admins only', async () => {
    const ok = await request(ctx.httpServer)
      .get('/api/v1/admin/hcm/breaker')
      .set('Authorization', bearer('admin_1', ['ADMIN']))
      .expect(200);
    expect((ok.body as { state: string }).state).toBe('OPEN');

    await request(ctx.httpServer)
      .get('/api/v1/admin/hcm/breaker')
      .set('Authorization', bearer('mgr_001', ['MANAGER']))
      .expect(403);
  });

  it('recovers after cool-down: the HALF_OPEN probe succeeds and closes the breaker (REQ-SYNC-06)', async () => {
    // HCM is healthy again.
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'normal' } });
    await sleep(COOLDOWN_MS + 250); // cool-down elapses → next call drives the probe

    // emp_c was left SUBMITTED by the 503 fast-fail; approving it now falls
    // through the pre-gate (no longer hard-open) into the decorator's probe.
    const res = await approve('emp_c').expect(202);
    expect((res.body as RequestResponse).status).toBe('APPROVED');

    const breaker = await request(ctx.httpServer)
      .get('/api/v1/admin/hcm/breaker')
      .set('Authorization', bearer('admin_1', ['ADMIN']))
      .expect(200);
    expect((breaker.body as { state: string }).state).toBe('CLOSED');
  });
});

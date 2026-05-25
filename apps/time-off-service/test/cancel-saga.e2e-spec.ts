import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { AuditLog, Balance, Employee, Location, TimeOffRequest } from '../src/database/entities';
import { CircuitBreaker } from '../src/modules/hcm-sync/circuit-breaker';
import { HcmClient } from '../src/modules/hcm-sync/hcm-client';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';

/**
 * Cancellation saga over HTTP against the real mock HCM (out-of-band control
 * plane drives the F-04 chaos scenario). The reverse direction of the approval
 * saga: SUBMITTED cancels release the reservation locally, APPROVED future-dated
 * cancels run the reverse HCM increment, APPROVAL_FAILED cancels discard. The
 * frozen contract under test is `POST /api/v1/requests/:id/cancel` — Owner or
 * Admin only; a manager-of-owner who can APPROVE is forbidden from CANCEL.
 *
 * These specs encode the Plan 05 contract before integration; they fail at the
 * HTTP layer (404 route-missing) until the core cancel route lands.
 *
 * @req REQ-LIFE-08
 * @req REQ-LIFE-09
 * @req REQ-LIFE-10
 * @req REQ-LIFE-11
 * @req REQ-LIFE-13
 * @req REQ-LIFE-14
 * @req REQ-DEF-10
 * @req REQ-SYNC-06
 */
describe('POST /api/v1/requests/:id/cancel (e2e)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  const LOC = 'loc_001';
  const MGR = 'mgr_001';
  // Clearly-future and clearly-past dates relative to any real `today`, so the
  // T-09 `start_date > today` gate is exercised deterministically regardless of
  // when the suite runs.
  const FUTURE_START = '2030-01-01';
  const FUTURE_END = '2030-01-03';
  const PAST_START = '2020-01-01';
  const PAST_END = '2020-01-03';

  /** Seeds an employee + balance (and the mirrored mock-HCM balance). */
  async function seedEmployee(id: string, total: number, reserved: number): Promise<void> {
    await ctx.dataSource.getRepository(Employee).insert({
      id,
      email: `${id}@x.io`,
      firstName: 'E',
      lastName: 'O',
      locationId: LOC,
      managerId: MGR,
    });
    await ctx.dataSource.getRepository(Balance).insert({
      id: `bal_${id}`,
      employeeId: id,
      locationId: LOC,
      totalDays: total,
      reservedDays: reserved,
      version: 0,
    });
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/balances')
      .send({ employee_id: id, location_id: LOC, total_days: total });
  }

  /** Inserts a request row directly in a target state (used to seed terminal/transient states). */
  async function seedRequest(
    id: string,
    employeeId: string,
    status: TimeOffRequest['status'],
    days: number,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    await ctx.dataSource.getRepository(TimeOffRequest).insert({
      id,
      employeeId,
      locationId: LOC,
      startDate,
      endDate,
      daysRequested: days,
      status,
      submittedAt: new Date(),
    });
  }

  const cancel = (reqId: string, sub: string, roles: ('EMPLOYEE' | 'MANAGER' | 'ADMIN')[]) =>
    request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/cancel`)
      .set('Authorization', bearer(sub, roles))
      .set('Idempotency-Key', randomUUID());

  /** All recorded adjust calls (oldest first), with their idempotency keys. */
  async function adjustCalls(): Promise<{ path: string; key?: string }[]> {
    const res = await request(mock.getHttpServer() as Server)
      .get('/mock/control/calls')
      .expect(200);
    const body = res.body as {
      calls: { path: string; headers: { 'idempotency-key'?: string } }[];
    };
    return body.calls
      .filter((c) => c.path.includes('/hcm/balances/adjust'))
      .map((c) => ({ path: c.path, key: c.headers['idempotency-key'] }));
  }

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('full lifecycle: submit → approve → cancel future-dated → 202 CANCELLED, balance restored via increment (T-01,02,03,09,10)', async () => {
    // Start with reserved_days: 0 so the only reservation in play is this
    // request's own — keeps the post-cancel balance assertion unambiguous.
    await seedEmployee('emp_life', 10, 0);

    // 1. Submit (SUBMITTED, reserved +3). Submitted via HTTP for the full path.
    const submitted = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_life', ['EMPLOYEE']))
      .set('Idempotency-Key', randomUUID())
      .send({
        location_id: LOC,
        start_date: FUTURE_START,
        end_date: FUTURE_END,
        days_requested: 3,
      })
      .expect(201);
    const reqId = (submitted.body as RequestResponse).id;

    // 2. Approve (APPROVED, total committed 10 → 7 via decrement, reserved → 0).
    const approved = await request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/approve`)
      .set('Authorization', bearer(MGR, ['MANAGER']))
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    expect((approved.body as RequestResponse).status).toBe('APPROVED');

    const adjustsBeforeCancel = (await adjustCalls()).length;

    // 3. Cancel future-dated APPROVED → reverse saga (HCM increment) → 202 CANCELLED.
    const res = await cancel(reqId, 'emp_life', ['EMPLOYEE']).expect(202);
    const body = res.body as RequestResponse;
    expect(body.status).toBe('CANCELLED');
    expect(body.hcm_correlation_id).toBeTruthy();

    // Balance restored: total back to the pre-approval 10 via the increment.
    // reserved_days stays 0 (the cancel touches total, not the reservation).
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_life' });
    expect(balance.totalDays).toBe(10);
    expect(balance.reservedDays).toBe(0);

    // The reverse saga used exactly one new adjust call, keyed `<id>:increment`.
    const newCalls = (await adjustCalls()).slice(adjustsBeforeCancel);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]?.key).toBe(`${reqId}:increment`);

    // Audit trail has the paired reverse-saga rows.
    const audit = ctx.dataSource.getRepository(AuditLog);
    await audit.findOneByOrFail({ action: 'request.cancelling', entityId: reqId });
    await audit.findOneByOrFail({ action: 'request.cancelled', entityId: reqId });
    await audit.findOneByOrFail({ action: 'hcm.increment.confirmed', entityId: reqId });
  });

  it('cancels a SUBMITTED request → 200 CANCELLED, reservation released, no HCM call (T-08, REQ-LIFE-08)', async () => {
    await seedEmployee('emp_sub', 10, 3);
    await seedRequest('req_sub', 'emp_sub', 'SUBMITTED', 3, FUTURE_START, FUTURE_END);

    const before = (await adjustCalls()).length;
    const res = await cancel('req_sub', 'emp_sub', ['EMPLOYEE']).expect(200);
    expect((res.body as RequestResponse).status).toBe('CANCELLED');

    // reserved_days decremented by days_requested (3 → 0); total untouched.
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_sub' });
    expect(balance.reservedDays).toBe(0);
    expect(balance.totalDays).toBe(10);

    // No HCM adjust for this local-only release.
    expect((await adjustCalls()).length).toBe(before);
  });

  it('discards an APPROVAL_FAILED request → 200 CANCELLED, no HCM call, no balance change, audit request.discarded (T-06, REQ-LIFE-13)', async () => {
    // APPROVAL_FAILED already released its reservation (T-04), so reserved is 0.
    await seedEmployee('emp_disc', 10, 0);
    await seedRequest('req_disc', 'emp_disc', 'APPROVAL_FAILED', 3, FUTURE_START, FUTURE_END);

    const before = (await adjustCalls()).length;
    const res = await cancel('req_disc', 'emp_disc', ['EMPLOYEE']).expect(200);
    expect((res.body as RequestResponse).status).toBe('CANCELLED');

    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_disc' });
    expect(balance.totalDays).toBe(10);
    expect(balance.reservedDays).toBe(0);
    expect((await adjustCalls()).length).toBe(before);

    // The discard gets its own audit action, distinct from request.cancelled (ADR-012).
    await ctx.dataSource.getRepository(AuditLog).findOneByOrFail({
      action: 'request.discarded',
      entityId: 'req_disc',
    });
  });

  it('rejects a cancel during APPROVING → 409 invalid-state-transition (R-05, REQ-LIFE-14)', async () => {
    await seedEmployee('emp_apv', 10, 0);
    await seedRequest('req_apv', 'emp_apv', 'APPROVING', 3, FUTURE_START, FUTURE_END);

    const res = await cancel('req_apv', 'emp_apv', ['EMPLOYEE']).expect(409);
    expect((res.body as { type: string }).type).toBe('/errors/invalid-state-transition');
  });

  it('rejects a cancel during CANCELLING → 409 invalid-state-transition (R-05)', async () => {
    await seedEmployee('emp_cancelling', 10, 0);
    await seedRequest(
      'req_cancelling',
      'emp_cancelling',
      'CANCELLING',
      3,
      FUTURE_START,
      FUTURE_END,
    );

    const res = await cancel('req_cancelling', 'emp_cancelling', ['EMPLOYEE']).expect(409);
    expect((res.body as { type: string }).type).toBe('/errors/invalid-state-transition');
  });

  it('rejects a cancel of a past-dated APPROVED request → 409 (TRD §5.3 start_date <= today gate)', async () => {
    await seedEmployee('emp_past', 10, 0);
    await seedRequest('req_past', 'emp_past', 'APPROVED', 3, PAST_START, PAST_END);

    await cancel('req_past', 'emp_past', ['EMPLOYEE']).expect(409);
  });

  it('forbids a manager-of-owner from cancelling → 403 (managers approve but never cancel, REQ-DEF-10)', async () => {
    // The discriminator vs approve auth: MGR is emp_mgrcase's manager and could
    // APPROVE this request, but cancel is Owner-or-Admin only → 403.
    await seedEmployee('emp_mgrcase', 10, 3);
    await seedRequest('req_mgrcase', 'emp_mgrcase', 'SUBMITTED', 3, FUTURE_START, FUTURE_END);

    await cancel('req_mgrcase', MGR, ['MANAGER']).expect(403);

    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_mgrcase' });
    expect(req.status).toBe('SUBMITTED');
  });

  it('forbids a stranger (non-owner, non-admin) from cancelling → 403 (REQ-DEF-10)', async () => {
    await seedEmployee('emp_owner', 10, 3);
    await seedRequest('req_owner', 'emp_owner', 'SUBMITTED', 3, FUTURE_START, FUTURE_END);

    await cancel('req_owner', 'stranger_999', ['EMPLOYEE']).expect(403);

    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_owner' });
    expect(req.status).toBe('SUBMITTED');
  });

  it('lets an ADMIN cancel a SUBMITTED request on behalf of an employee → 200 CANCELLED (auth matrix, api-contract §3)', async () => {
    await seedEmployee('emp_admincase', 10, 3);
    await seedRequest('req_admincase', 'emp_admincase', 'SUBMITTED', 3, FUTURE_START, FUTURE_END);

    const res = await cancel('req_admincase', 'admin_1', ['ADMIN']).expect(200);
    expect((res.body as RequestResponse).status).toBe('CANCELLED');

    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_admincase' });
    expect(balance.reservedDays).toBe(0);
  });

  it('CHAOS F-04: unverifiable HCM increment success → 202 CANCELLATION_FAILED, total UNCHANGED (released nothing) (REQ-LIFE-11, F-04)', async () => {
    // Approve cleanly first so the request is genuinely APPROVED with total
    // committed (10 → 7), THEN scope the chaos scenario to this employee so only
    // the cancel's increment hits the unverifiable response.
    await seedEmployee('emp_chaos', 10, 0);
    const submitted = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_chaos', ['EMPLOYEE']))
      .set('Idempotency-Key', randomUUID())
      .send({
        location_id: LOC,
        start_date: FUTURE_START,
        end_date: FUTURE_END,
        days_requested: 3,
      })
      .expect(201);
    const reqId = (submitted.body as RequestResponse).id;
    await request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/approve`)
      .set('Authorization', bearer(MGR, ['MANAGER']))
      .set('Idempotency-Key', randomUUID())
      .expect(202);

    // Now drive the increment into an unverifiable success (HCM stays at 7; the
    // arithmetic check expects 7 + 3 = 10 and sees 7 → mismatch → ambiguous).
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'unverifiable-success' }, scope: { employee_id: 'emp_chaos' } });

    const res = await cancel(reqId, 'emp_chaos', ['EMPLOYEE']).expect(202);
    const body = res.body as RequestResponse;
    expect(body.status).toBe('CANCELLATION_FAILED');
    expect(body.failure_reason).toBe('hcm_ambiguous');

    // "Released nothing": total stays at the post-approve 7, NOT restored to 10.
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_chaos' });
    expect(balance.totalDays).toBe(7);

    // The failure is audited (cheap contract-tightener per Plan 05 audit signals).
    await ctx.dataSource.getRepository(AuditLog).findOneByOrFail({
      action: 'request.cancellation_failed',
      entityId: reqId,
    });
  });
});

/**
 * Breaker-OPEN behavior for the reverse cancellation saga, in its own bootstrap
 * so the tripped breaker state cannot leak into the happy-path suite. Trips the
 * shared CircuitBreaker directly (the deterministic technique reconciliation.e2e
 * uses) rather than burning HCM failures, then proves the APPROVED future-dated
 * cancel fast-fails 503 BEFORE any state change.
 *
 * @req REQ-SYNC-06
 */
describe('Cancel reverse saga — breaker OPEN fast-fail (e2e chaos)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  const LOC = 'loc_001';

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmBaseUrl: await mock.getUrl() });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: 'emp_brk',
      email: 'b@x.io',
      firstName: 'B',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });
    await ctx.dataSource.getRepository(Balance).insert({
      id: 'bal_emp_brk',
      employeeId: 'emp_brk',
      locationId: LOC,
      totalDays: 7,
      reservedDays: 0,
      version: 0,
    });
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/balances')
      .send({ employee_id: 'emp_brk', location_id: LOC, total_days: 7 });
    // Seed a genuine APPROVED future-dated request to cancel.
    await ctx.dataSource.getRepository(TimeOffRequest).insert({
      id: 'req_brk',
      employeeId: 'emp_brk',
      locationId: LOC,
      startDate: '2030-01-01',
      endDate: '2030-01-03',
      daysRequested: 3,
      status: 'APPROVED',
      submittedAt: new Date(),
      hcmCorrelationId: 'corr_brk',
    });
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('returns 503 hcm-unavailable and leaves the request APPROVED when the breaker is OPEN (REQ-SYNC-06)', async () => {
    // Trip the shared breaker to hard-OPEN (5 consecutive failures crosses the threshold).
    const breaker = ctx.app.get(CircuitBreaker);
    for (let i = 0; i < 5; i++) breaker.recordFailure();
    expect(breaker.isHardOpen()).toBe(true);

    const res = await request(ctx.httpServer)
      .post('/api/v1/requests/req_brk/cancel')
      .set('Authorization', bearer('emp_brk', ['EMPLOYEE']))
      .set('Idempotency-Key', randomUUID())
      .expect(503);
    expect((res.body as { type: string }).type).toBe('/errors/hcm-unavailable');

    // The pre-gate fast-fails BEFORE any transition: still APPROVED, not CANCELLING.
    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_brk' });
    expect(req.status).toBe('APPROVED');
  });
});

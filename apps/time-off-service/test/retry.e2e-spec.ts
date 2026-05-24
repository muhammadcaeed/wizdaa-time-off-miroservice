import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { Balance, Employee, Location, TimeOffRequest } from '../src/database/entities';
import { HcmClient } from '../src/modules/hcm-sync/hcm-client';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';

/**
 * Admin retry endpoints: APPROVAL_FAILED → retry → APPROVING/APPROVED and
 * CANCELLATION_FAILED → retry → CANCELLING/CANCELLED.
 *
 * @req REQ-LIFE-06
 * @req REQ-LIFE-12
 */
describe('Admin retry endpoints (e2e)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  const LOC = 'loc_retry';
  const MGR = 'mgr_retry';
  const ADMIN = 'adm_retry';
  const FUTURE_START = '2030-01-01';
  const FUTURE_END = '2030-01-03';

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
    await request(mock.getHttpServer())
      .post('/mock/control/balances')
      .send({ employee_id: id, location_id: LOC, total_days: total });
  }

  async function seedRequest(
    id: string,
    employeeId: string,
    status: TimeOffRequest['status'],
    days: number,
  ): Promise<void> {
    await ctx.dataSource.getRepository(TimeOffRequest).insert({
      id,
      employeeId,
      locationId: LOC,
      startDate: FUTURE_START,
      endDate: FUTURE_END,
      daysRequested: days,
      status,
      submittedAt: new Date(),
    });
  }

  const retryApproval = (reqId: string, sub: string, roles: ('EMPLOYEE' | 'MANAGER' | 'ADMIN')[]) =>
    request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/approval-retries`)
      .set('Authorization', bearer(sub, roles));

  const retryCancellation = (
    reqId: string,
    sub: string,
    roles: ('EMPLOYEE' | 'MANAGER' | 'ADMIN')[],
  ) =>
    request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/cancellation-retries`)
      .set('Authorization', bearer(sub, roles));

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource
      .getRepository(Location)
      .insert({ id: LOC, name: 'Retry HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert([
      {
        id: MGR,
        email: 'm@retry.io',
        firstName: 'M',
        lastName: 'O',
        locationId: LOC,
        managerId: null,
      },
    ]);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  // ── Approval retry ─────────────────────────────────────────────────────────

  describe('POST /api/v1/requests/:id/approval-retries', () => {
    it('non-admin gets 403 (T-05, REQ-LIFE-06)', async () => {
      await seedEmployee('emp_ra_forbidden', 10, 0);
      await seedRequest('req_ra_forbidden', 'emp_ra_forbidden', 'APPROVAL_FAILED', 3);

      await retryApproval('req_ra_forbidden', 'emp_ra_forbidden', ['EMPLOYEE']).expect(403);
      await retryApproval('req_ra_forbidden', MGR, ['MANAGER']).expect(403);

      // State unchanged
      const row = await ctx.dataSource
        .getRepository(TimeOffRequest)
        .findOneByOrFail({ id: 'req_ra_forbidden' });
      expect(row.status).toBe('APPROVAL_FAILED');
    });

    it('admin retries APPROVAL_FAILED → 202, response status is APPROVING or APPROVED (T-05)', async () => {
      await seedEmployee('emp_ra_ok', 10, 0);
      // Seed APPROVAL_FAILED with no reserved days (reservation was released on failure)
      await seedRequest('req_ra_ok', 'emp_ra_ok', 'APPROVAL_FAILED', 3);

      const res = await retryApproval('req_ra_ok', ADMIN, ['ADMIN']).expect(202);
      const body = res.body as RequestResponse;
      // The mock HCM responds success → should commit to APPROVED
      expect(['APPROVING', 'APPROVED']).toContain(body.status);

      // If APPROVED, balance should reflect the decrement
      if (body.status === 'APPROVED') {
        const balance = await ctx.dataSource
          .getRepository(Balance)
          .findOneByOrFail({ id: 'bal_emp_ra_ok' });
        expect(balance.totalDays).toBe(7); // 10 − 3
        expect(balance.reservedDays).toBe(0); // reserved released after commit
      }
    });

    it('admin retries wrong state (SUBMITTED → 409 invalid transition)', async () => {
      await seedEmployee('emp_ra_wrong_state', 10, 3);
      await seedRequest('req_ra_wrong_state', 'emp_ra_wrong_state', 'SUBMITTED', 3);

      const res = await retryApproval('req_ra_wrong_state', ADMIN, ['ADMIN']).expect(409);
      expect((res.body as { type: string }).type).toBe('/errors/invalid-state-transition');
    });

    it('admin retries APPROVAL_FAILED with insufficient balance → 409 insufficient-balance, state unchanged', async () => {
      // 2 total days, 0 reserved, but request wants 5 → insufficient
      await seedEmployee('emp_ra_insuf', 2, 0);
      await seedRequest('req_ra_insuf', 'emp_ra_insuf', 'APPROVAL_FAILED', 5);

      const res = await retryApproval('req_ra_insuf', ADMIN, ['ADMIN']).expect(409);
      expect((res.body as { type: string }).type).toBe('/errors/insufficient-balance');

      // State unchanged
      const row = await ctx.dataSource
        .getRepository(TimeOffRequest)
        .findOneByOrFail({ id: 'req_ra_insuf' });
      expect(row.status).toBe('APPROVAL_FAILED');
    });
  });

  // ── Cancellation retry ─────────────────────────────────────────────────────

  describe('POST /api/v1/requests/:id/cancellation-retries', () => {
    it('non-admin gets 403', async () => {
      await seedEmployee('emp_rc_forbidden', 7, 0);
      await seedRequest('req_rc_forbidden', 'emp_rc_forbidden', 'CANCELLATION_FAILED', 3);

      await retryCancellation('req_rc_forbidden', 'emp_rc_forbidden', ['EMPLOYEE']).expect(403);
      await retryCancellation('req_rc_forbidden', MGR, ['MANAGER']).expect(403);

      const row = await ctx.dataSource
        .getRepository(TimeOffRequest)
        .findOneByOrFail({ id: 'req_rc_forbidden' });
      expect(row.status).toBe('CANCELLATION_FAILED');
    });

    it('admin retries CANCELLATION_FAILED → 202, response status is CANCELLING or CANCELLED (T-12)', async () => {
      await seedEmployee('emp_rc_ok', 7, 0);
      await seedRequest('req_rc_ok', 'emp_rc_ok', 'CANCELLATION_FAILED', 3);

      const res = await retryCancellation('req_rc_ok', ADMIN, ['ADMIN']).expect(202);
      const body = res.body as RequestResponse;
      expect(['CANCELLING', 'CANCELLED']).toContain(body.status);

      // If CANCELLED, balance should reflect the increment
      if (body.status === 'CANCELLED') {
        const balance = await ctx.dataSource
          .getRepository(Balance)
          .findOneByOrFail({ id: 'bal_emp_rc_ok' });
        expect(balance.totalDays).toBe(10); // 7 + 3 restored
      }
    });

    it('admin retries wrong state (SUBMITTED → 409 invalid transition)', async () => {
      await seedEmployee('emp_rc_wrong_state', 10, 3);
      await seedRequest('req_rc_wrong_state', 'emp_rc_wrong_state', 'SUBMITTED', 3);

      const res = await retryCancellation('req_rc_wrong_state', ADMIN, ['ADMIN']).expect(409);
      expect((res.body as { type: string }).type).toBe('/errors/invalid-state-transition');
    });
  });
});

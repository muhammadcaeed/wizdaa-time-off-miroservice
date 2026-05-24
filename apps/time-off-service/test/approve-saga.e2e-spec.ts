import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { Balance, Employee, Location, TimeOffRequest } from '../src/database/entities';
import { HcmClient } from '../src/modules/hcm-sync/hcm-client';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';

/**
 * Full approval saga over HTTP against the real mock HCM (out-of-band control
 * plane drives the F-04 chaos scenario).
 *
 * @req REQ-LIFE-03
 * @req REQ-LIFE-04
 * @req REQ-LIFE-05
 * @req REQ-LIFE-15
 * @req REQ-LIFE-16
 * @req REQ-SYNC-04
 */
describe('POST /api/v1/requests/:id/approve (e2e)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource
      .getRepository(Location)
      .insert({ id: 'loc_001', name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert([
      {
        id: 'mgr_001',
        email: 'm@x.io',
        firstName: 'M',
        lastName: 'O',
        locationId: 'loc_001',
        managerId: null,
      },
      {
        id: 'emp_h',
        email: 'h@x.io',
        firstName: 'H',
        lastName: 'O',
        locationId: 'loc_001',
        managerId: 'mgr_001',
      },
      {
        id: 'emp_x',
        email: 'x@x.io',
        firstName: 'X',
        lastName: 'O',
        locationId: 'loc_001',
        managerId: 'mgr_001',
      },
      {
        id: 'emp_f',
        email: 'f@x.io',
        firstName: 'F',
        lastName: 'O',
        locationId: 'loc_001',
        managerId: 'mgr_001',
      },
    ]);
    for (const emp of ['emp_h', 'emp_x', 'emp_f']) {
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
      await request(mock.getHttpServer())
        .post('/mock/control/balances')
        .send({ employee_id: emp, location_id: 'loc_001', total_days: 10 });
    }
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  const approve = (reqId: string, sub: string, roles: ('EMPLOYEE' | 'MANAGER' | 'ADMIN')[]) =>
    request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/approve`)
      .set('Authorization', bearer(sub, roles))
      .set('Idempotency-Key', randomUUID());

  it('forbids a non-manager-of-owner (403, REQ-LIFE-15)', async () => {
    await approve('req_emp_x', 'mgr_999', ['MANAGER']).expect(403);
    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_emp_x' });
    expect(req.status).toBe('SUBMITTED');
  });

  it('approves a direct report: 202 APPROVED, balance committed, correlation id stored (T-03)', async () => {
    const res = await approve('req_emp_h', 'mgr_001', ['MANAGER']).expect(202);
    const body = res.body as RequestResponse;
    expect(body.status).toBe('APPROVED');
    expect(body.hcm_correlation_id).toBeTruthy();

    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_h' });
    expect(balance.totalDays).toBe(7);
    expect(balance.reservedDays).toBe(0);
  });

  it('rejects approving a non-SUBMITTED request (409, REQ-LIFE-16)', async () => {
    await approve('req_emp_h', 'mgr_001', ['MANAGER']).expect(409);
  });

  it('F-04: unverifiable HCM success drives APPROVAL_FAILED and releases the reservation', async () => {
    await request(mock.getHttpServer())
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'unverifiable-success' }, scope: { employee_id: 'emp_f' } });

    const res = await approve('req_emp_f', 'mgr_001', ['MANAGER']).expect(202);
    const body = res.body as RequestResponse;
    expect(body.status).toBe('APPROVAL_FAILED');
    expect(body.failure_reason).toBe('hcm_ambiguous');

    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_f' });
    expect(balance.totalDays).toBe(10); // unchanged
    expect(balance.reservedDays).toBe(0); // released
  });
});

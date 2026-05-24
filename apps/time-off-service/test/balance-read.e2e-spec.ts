import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { Balance, Employee, Location } from '../src/database/entities';
import type { BalanceResponse } from '../src/modules/balances/dto/balance-response.dto';

/**
 * @req REQ-BAL-01
 * @req REQ-BAL-02
 * @req REQ-BAL-03
 * @req REQ-BAL-04
 * @req REQ-BAL-05
 * @req REQ-DEF-10
 */
describe('GET /api/v1/balances/employees/:employee_id (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
    await ctx.dataSource.getRepository(Location).insert({
      id: 'loc_001',
      name: 'HQ',
      countryCode: 'US',
    });
    await ctx.dataSource.getRepository(Employee).insert([
      {
        id: 'emp_001',
        email: 'e1@x.io',
        firstName: 'E',
        lastName: 'One',
        locationId: 'loc_001',
        managerId: 'mgr_001',
      },
      {
        id: 'emp_002',
        email: 'e2@x.io',
        firstName: 'E',
        lastName: 'Two',
        locationId: 'loc_001',
        managerId: 'mgr_999',
      },
      {
        id: 'mgr_001',
        email: 'm1@x.io',
        firstName: 'M',
        lastName: 'One',
        locationId: 'loc_001',
        managerId: null,
      },
    ]);
    await ctx.dataSource.getRepository(Balance).insert({
      id: 'bal_001',
      employeeId: 'emp_001',
      locationId: 'loc_001',
      totalDays: 20,
      reservedDays: 5,
      version: 0,
      lastHcmSyncAt: new Date('2026-05-01T00:00:00Z'),
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  const url = (id: string) => `/api/v1/balances/employees/${id}`;

  it('rejects a request with no bearer token (401)', async () => {
    await request(ctx.httpServer).get(url('emp_001')).expect(401);
  });

  it('rejects a request with an invalid bearer token (401)', async () => {
    await request(ctx.httpServer)
      .get(url('emp_001'))
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('returns own balance with available_days and last_hcm_sync_at (200)', async () => {
    const res = await request(ctx.httpServer)
      .get(url('emp_001'))
      .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
      .expect(200);

    const body = res.body as BalanceResponse;
    expect(body.balances).toHaveLength(1);
    expect(body.balances[0]).toMatchObject({
      location_id: 'loc_001',
      total_days: 20,
      reserved_days: 5,
      available_days: 15,
    });
    expect(body.balances[0].last_hcm_sync_at).toBeTruthy();
  });

  it('lets a manager read a direct report (200)', async () => {
    await request(ctx.httpServer)
      .get(url('emp_001'))
      .set('Authorization', bearer('mgr_001', ['EMPLOYEE', 'MANAGER']))
      .expect(200);
  });

  it('forbids a manager reading a non-report (403)', async () => {
    await request(ctx.httpServer)
      .get(url('emp_002'))
      .set('Authorization', bearer('mgr_001', ['EMPLOYEE', 'MANAGER']))
      .expect(403);
  });

  it('returns 403 (not 404) for a nonexistent employee — no existence leak', async () => {
    await request(ctx.httpServer)
      .get(url('emp_ghost'))
      .set('Authorization', bearer('mgr_001', ['EMPLOYEE', 'MANAGER']))
      .expect(403);
  });

  it('lets an admin read anyone (200)', async () => {
    await request(ctx.httpServer)
      .get(url('emp_002'))
      .set('Authorization', bearer('adm_001', ['ADMIN']))
      .expect(200);
  });
});

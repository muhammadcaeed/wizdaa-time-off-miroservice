import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { Balance, Employee, Location } from '../src/database/entities';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';

/**
 * @req REQ-LIFE-01
 * @req REQ-LIFE-02
 * @req INV-02
 */
describe('POST /api/v1/requests (e2e)', () => {
  let ctx: E2EContext;

  const submit = (employeeId: string, days: number) => ({
    location_id: 'loc_001',
    start_date: '2026-07-01',
    end_date: '2026-07-05',
    days_requested: days,
  });

  beforeAll(async () => {
    ctx = await bootstrapE2E();
    await ctx.dataSource
      .getRepository(Location)
      .insert({ id: 'loc_001', name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert([
      {
        id: 'emp_001',
        email: 'e1@x.io',
        firstName: 'E',
        lastName: 'One',
        locationId: 'loc_001',
        managerId: null,
      },
      {
        id: 'emp_r01',
        email: 'r1@x.io',
        firstName: 'R',
        lastName: 'One',
        locationId: 'loc_001',
        managerId: null,
      },
    ]);
    await ctx.dataSource.getRepository(Balance).insert([
      {
        id: 'bal_001',
        employeeId: 'emp_001',
        locationId: 'loc_001',
        totalDays: 10,
        reservedDays: 0,
        version: 0,
      },
      {
        id: 'bal_r01',
        employeeId: 'emp_r01',
        locationId: 'loc_001',
        totalDays: 5,
        reservedDays: 0,
        version: 0,
      },
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rejects an unauthenticated submit (401)', async () => {
    await request(ctx.httpServer).post('/api/v1/requests').send(submit('emp_001', 3)).expect(401);
  });

  it('rejects an unknown field (400, whitelist)', async () => {
    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
      .send({ ...submit('emp_001', 1), sneaky: 'x' })
      .expect(400);
  });

  it('creates a SUBMITTED request and reserves days (201)', async () => {
    const res = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
      .send(submit('emp_001', 4))
      .expect(201);

    const body = res.body as RequestResponse;
    expect(body.status).toBe('SUBMITTED');
    expect(body.employee_id).toBe('emp_001');
    expect(body.days_requested).toBe(4);
  });

  it('rejects a submit exceeding available balance (409)', async () => {
    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
      .send(submit('emp_001', 100))
      .expect(409);
  });

  it('R-01: two concurrent submits that jointly exceed balance resolve to exactly one 201 and one 409', async () => {
    const post = () =>
      request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_r01', ['EMPLOYEE']))
        .send(submit('emp_r01', 3));

    const results = await Promise.all([post(), post()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);

    const balance = await ctx.dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_r01' });
    expect(balance.reservedDays).toBe(3);
    expect(balance.totalDays - balance.reservedDays).toBeGreaterThanOrEqual(0);
  });
});

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { bearer } from '../../../test/support/auth';
import { Balance, Employee, Location } from '../src/database/entities';

/**
 * E2E tests for X-Correlation-ID header propagation.
 *
 * Contract (REQ-LOG-01):
 *  - Every response carries an `x-correlation-id` header.
 *  - If the request supplied `X-Correlation-ID`, the response echoes it verbatim.
 *  - If the request omitted it, the response carries the server-generated UUID.
 *
 * @req REQ-LOG-01
 */
describe('X-Correlation-ID propagation (e2e)', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
    // Seed minimal fixtures so POST /api/v1/requests can reach the handler
    await ctx.dataSource
      .getRepository(Location)
      .insert({ id: 'loc_corr', name: 'Corr-HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: 'emp_corr',
      email: 'corr@x.io',
      firstName: 'Corr',
      lastName: 'Test',
      locationId: 'loc_corr',
      managerId: null,
    });
    await ctx.dataSource.getRepository(Balance).insert({
      id: 'bal_corr',
      employeeId: 'emp_corr',
      locationId: 'loc_corr',
      totalDays: 20,
      reservedDays: 0,
      version: 0,
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('response includes x-correlation-id header when request omits it', async () => {
    const res = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_corr', ['EMPLOYEE']))
      .set('Idempotency-Key', randomUUID())
      .send({
        location_id: 'loc_corr',
        start_date: '2027-01-10',
        end_date: '2027-01-12',
        days_requested: 2,
      })
      .expect(201);

    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['x-correlation-id']).toMatch(UUID_PATTERN);
  });

  it('response echoes the supplied X-Correlation-ID verbatim', async () => {
    const correlationId = 'my-client-trace-id-9999';
    const res = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', bearer('emp_corr', ['EMPLOYEE']))
      .set('X-Correlation-ID', correlationId)
      .set('Idempotency-Key', randomUUID())
      .send({
        location_id: 'loc_corr',
        start_date: '2027-02-01',
        end_date: '2027-02-03',
        days_requested: 2,
      })
      .expect(201);

    expect(res.headers['x-correlation-id']).toBe(correlationId);
  });

  it('even a 401 response carries x-correlation-id', async () => {
    const res = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .send({
        location_id: 'loc_corr',
        start_date: '2027-03-01',
        end_date: '2027-03-03',
        days_requested: 1,
      })
      .expect(401);

    expect(res.headers['x-correlation-id']).toBeDefined();
  });
});

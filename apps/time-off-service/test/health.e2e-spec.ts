import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import type { HealthResult } from '../src/modules/health/health.service';

/**
 * @req REQ-HEALTH-01
 * @req REQ-RATE-01
 */
describe('GET /api/v1/health (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns 200 with healthy status without auth', async () => {
    const res = await request(ctx.httpServer).get('/api/v1/health').expect(200);
    const body = res.body as HealthResult;

    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(['up', 'down']).toContain(body.checks.database.status);
    expect(typeof body.checks.database.response_time_ms).toBe('number');
    expect(['up', 'down', 'unknown']).toContain(body.checks.hcm.status);
    expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(body.checks.hcm.circuit_state);
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns 200 even with a valid auth header (auth not required)', async () => {
    const res = await request(ctx.httpServer)
      .get('/api/v1/health')
      .set('Authorization', bearer('emp_health_test', ['EMPLOYEE']))
      .expect(200);
    const body = res.body as HealthResult;

    expect(body.status).toBeDefined();
  });

  it('database check shows "up" in test environment', async () => {
    const res = await request(ctx.httpServer).get('/api/v1/health').expect(200);
    const body = res.body as HealthResult;

    // In e2e tests the SQLite DB is healthy
    expect(body.checks.database.status).toBe('up');
  });

  it('timestamp is a valid ISO-8601 date', async () => {
    const res = await request(ctx.httpServer).get('/api/v1/health').expect(200);
    const body = res.body as HealthResult;

    const ts = new Date(body.timestamp);
    expect(ts.getTime()).not.toBeNaN();
  });
});

describe('POST /api/v1/requests auth gate not broken by throttler (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('POST /requests without auth still returns 401 (throttler does not interfere)', async () => {
    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .send({
        location_id: 'x',
        start_date: '2026-07-01',
        end_date: '2026-07-05',
        days_requested: 1,
      })
      .expect(401);
  });
});

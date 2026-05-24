import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';

/**
 * Rate-limiting enforcement via @nestjs/throttler (api-contract.md §8).
 * Each describe block bootstraps its own app instance with a deliberately
 * low threshold so tests complete quickly without sleeping.
 *
 * @req REQ-RATE-01
 */
describe('Rate limiting — per-IP throttle (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    // Low IP limit so the 3rd request trips it; ThrottlerModule is replaced
    // directly so the limit is guaranteed regardless of env-load ordering.
    ctx = await bootstrapE2E({ throttleIpLimit: 2 });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('first two requests pass; third from same IP returns 429 with RFC 7807 envelope', async () => {
    // Use an authenticated request. The body is intentionally missing required
    // fields so it returns 400 — but the throttle counter increments regardless
    // because the ThrottlerGuard runs before the route handler.
    const auth = bearer('emp_rate_ip', ['EMPLOYEE']);

    // Requests 1 and 2 should NOT be throttled (returns 400 for bad body, not 429).
    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect((res) => {
        expect(res.status).not.toBe(429);
      });

    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect((res) => {
        expect(res.status).not.toBe(429);
      });

    // Request 3 — throttle limit reached.
    const res = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(429);

    const body = res.body as { status: number; type: string };
    expect(body.status).toBe(429);
    expect(body.type).toContain('rate-limited');
  });
});

describe('Rate limiting — per-sub throttle (e2e)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await bootstrapE2E({ throttleSubLimit: 2 });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('third request from same sub returns 429 regardless of IP', async () => {
    const auth = bearer('emp_rate_sub', ['EMPLOYEE']);

    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect((res) => {
        expect(res.status).not.toBe(429);
      });

    await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect((res) => {
        expect(res.status).not.toBe(429);
      });

    const res = await request(ctx.httpServer)
      .post('/api/v1/requests')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(429);

    const body = res.body as { status: number; type: string };
    expect(body.status).toBe(429);
    expect(body.type).toContain('rate-limited');
  });
});

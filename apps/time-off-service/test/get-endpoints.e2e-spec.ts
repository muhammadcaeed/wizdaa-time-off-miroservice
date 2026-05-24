import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import {
  Balance,
  Employee,
  Location,
  TimeOffRequest,
  type RequestStatus,
} from '../src/database/entities';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';
import type { RequestListResponse } from '../src/modules/time-off/dto/request-list-response.dto';

/**
 * @req REQ-DEF-10
 * @req REQ-LIST-01
 */
describe('GET /api/v1/requests (e2e)', () => {
  let ctx: E2EContext;

  /** Seeds a request row directly into the DB (bypasses balance checks). */
  async function seedRequest(
    id: string,
    employeeId: string,
    submittedAt: Date,
    status: RequestStatus = 'SUBMITTED',
  ): Promise<void> {
    await ctx.dataSource.getRepository(TimeOffRequest).insert({
      id,
      employeeId,
      locationId: 'loc_001',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      daysRequested: 3,
      status,
      submittedAt,
    });
  }

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
        id: 'emp_002',
        email: 'e2@x.io',
        firstName: 'E',
        lastName: 'Two',
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
        id: 'bal_002',
        employeeId: 'emp_002',
        locationId: 'loc_001',
        totalDays: 10,
        reservedDays: 0,
        version: 0,
      },
    ]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ─────────────────────────────────────────────
  // GET /requests/:id
  // ─────────────────────────────────────────────

  describe('GET /requests/:id', () => {
    beforeAll(async () => {
      await seedRequest('req_get_001', 'emp_001', new Date('2026-06-01T10:00:00Z'));
    });

    it('returns 200 with request data when the owner requests it', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests/req_get_001')
        .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
        .expect(200);

      const body = res.body as RequestResponse;
      expect(body.id).toBe('req_get_001');
      expect(body.employee_id).toBe('emp_001');
      expect(body.status).toBe('SUBMITTED');
    });

    it('returns 200 for an ADMIN viewing any request', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests/req_get_001')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(200);

      const body = res.body as RequestResponse;
      expect(body.id).toBe('req_get_001');
    });

    it('returns 200 for a MANAGER viewing any request', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests/req_get_001')
        .set('Authorization', bearer('mgr_001', ['MANAGER']))
        .expect(200);

      const body = res.body as RequestResponse;
      expect(body.id).toBe('req_get_001');
    });

    it('returns 403 (existence hiding) when a non-owner EMPLOYEE requests it', async () => {
      await request(ctx.httpServer)
        .get('/api/v1/requests/req_get_001')
        .set('Authorization', bearer('emp_002', ['EMPLOYEE']))
        .expect(403);
    });

    it('returns 403 (existence hiding) when a non-owner EMPLOYEE requests a non-existent id', async () => {
      await request(ctx.httpServer)
        .get('/api/v1/requests/non-existent-id')
        .set('Authorization', bearer('emp_002', ['EMPLOYEE']))
        .expect(403);
    });

    it('returns 404 when an ADMIN requests a non-existent id', async () => {
      await request(ctx.httpServer)
        .get('/api/v1/requests/non-existent-id')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(404);
    });

    it('returns 401 when no auth token is provided', async () => {
      await request(ctx.httpServer).get('/api/v1/requests/req_get_001').expect(401);
    });
  });

  // ─────────────────────────────────────────────
  // GET /requests
  // ─────────────────────────────────────────────

  describe('GET /requests', () => {
    // Seed requests with different employees and timestamps
    beforeAll(async () => {
      // emp_001 has 3 requests
      await seedRequest('req_list_001', 'emp_001', new Date('2026-05-01T10:00:00Z'));
      await seedRequest('req_list_002', 'emp_001', new Date('2026-05-02T10:00:00Z'));
      await seedRequest('req_list_003', 'emp_001', new Date('2026-05-03T10:00:00Z'), 'APPROVED');
      // emp_002 has 1 request
      await seedRequest('req_list_004', 'emp_002', new Date('2026-05-04T10:00:00Z'));
    });

    it('EMPLOYEE sees only their own requests', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests')
        .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
        .expect(200);

      const body = res.body as RequestListResponse;
      expect(body.data.every((r) => r.employee_id === 'emp_001')).toBe(true);
      // emp_001 has 3 requests (plus req_get_001 from the :id suite = 4 total)
      expect(body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('ADMIN sees all requests', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(200);

      const body = res.body as RequestListResponse;
      // emp_001 (4 with req_get_001) + emp_002 (1) = 5+ requests
      expect(body.data.length).toBeGreaterThanOrEqual(4);
    });

    it('MANAGER sees all requests', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests')
        .set('Authorization', bearer('mgr_001', ['MANAGER']))
        .expect(200);

      const body = res.body as RequestListResponse;
      expect(body.data.length).toBeGreaterThanOrEqual(4);
    });

    it('returns 200 with pagination envelope', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(200);

      const body = res.body as RequestListResponse;
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(body.pagination).toHaveProperty('next_cursor');
      expect(body.pagination).toHaveProperty('has_more');
    });

    it('limit=2 with 3+ requests gives has_more=true and next_cursor set', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests?limit=2')
        .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
        .expect(200);

      const body = res.body as RequestListResponse;
      expect(body.data).toHaveLength(2);
      expect(body.pagination.has_more).toBe(true);
      expect(body.pagination.next_cursor).not.toBeNull();
    });

    it('cursor from page 1 returns page 2 with no overlap', async () => {
      const res1 = await request(ctx.httpServer)
        .get('/api/v1/requests?limit=2')
        .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
        .expect(200);

      const body1 = res1.body as RequestListResponse;
      const cursor = body1.pagination.next_cursor!;

      const res2 = await request(ctx.httpServer)
        .get(`/api/v1/requests?limit=2&cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', bearer('emp_001', ['EMPLOYEE']))
        .expect(200);

      const body2 = res2.body as RequestListResponse;
      expect(body2.data.length).toBeGreaterThan(0);

      const ids1 = body1.data.map((r) => r.id);
      const ids2 = body2.data.map((r) => r.id);
      expect(ids1.every((id) => !ids2.includes(id))).toBe(true);
    });

    it('status filter returns only matching requests', async () => {
      const res = await request(ctx.httpServer)
        .get('/api/v1/requests?status=APPROVED')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(200);

      const body = res.body as RequestListResponse;
      expect(body.data.every((r) => r.status === 'APPROVED')).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('malformed cursor returns 400', async () => {
      await request(ctx.httpServer)
        .get('/api/v1/requests?cursor=invalid-cursor-string')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(400);
    });

    it('invalid limit (0) returns 400', async () => {
      await request(ctx.httpServer)
        .get('/api/v1/requests?limit=0')
        .set('Authorization', bearer('admin_001', ['ADMIN']))
        .expect(400);
    });

    it('returns 401 when no auth token is provided', async () => {
      await request(ctx.httpServer).get('/api/v1/requests').expect(401);
    });
  });
});

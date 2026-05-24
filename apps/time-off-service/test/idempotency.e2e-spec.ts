import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { Balance, Employee, IdempotencyRecord, Location } from '../src/database/entities';
import { HcmClient } from '../src/modules/hcm-sync/hcm-client';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';

/**
 * Client-facing idempotency for all POST endpoints (api-contract.md §6).
 *
 * @req REQ-IDEM-01
 * @req REQ-IDEM-02
 * @req REQ-IDEM-03
 * @req REQ-IDEM-04
 * @req REQ-IDEM-05
 */
describe('Idempotency (e2e)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  const submitBody = () => ({
    location_id: 'loc_idem',
    start_date: '2027-08-01',
    end_date: '2027-08-05',
    days_requested: 3,
  });

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource
      .getRepository(Location)
      .insert({ id: 'loc_idem', name: 'IDEM_HQ', countryCode: 'US' });

    await ctx.dataSource.getRepository(Employee).insert([
      {
        id: 'emp_idem_mgr',
        email: 'mgr_idem@x.io',
        firstName: 'M',
        lastName: 'Idem',
        locationId: 'loc_idem',
        managerId: null,
      },
      {
        id: 'emp_idem_1',
        email: 'e1_idem@x.io',
        firstName: 'E1',
        lastName: 'Idem',
        locationId: 'loc_idem',
        managerId: 'emp_idem_mgr',
      },
      {
        id: 'emp_idem_2',
        email: 'e2_idem@x.io',
        firstName: 'E2',
        lastName: 'Idem',
        locationId: 'loc_idem',
        managerId: 'emp_idem_mgr',
      },
      {
        id: 'emp_idem_3',
        email: 'e3_idem@x.io',
        firstName: 'E3',
        lastName: 'Idem',
        locationId: 'loc_idem',
        managerId: 'emp_idem_mgr',
      },
    ]);

    await ctx.dataSource.getRepository(Balance).insert([
      {
        id: 'bal_idem_1',
        employeeId: 'emp_idem_1',
        locationId: 'loc_idem',
        totalDays: 20,
        reservedDays: 0,
        version: 0,
      },
      {
        id: 'bal_idem_2',
        employeeId: 'emp_idem_2',
        locationId: 'loc_idem',
        totalDays: 20,
        reservedDays: 0,
        version: 0,
      },
      {
        id: 'bal_idem_3',
        employeeId: 'emp_idem_3',
        locationId: 'loc_idem',
        totalDays: 20,
        reservedDays: 0,
        version: 0,
      },
    ]);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  describe('POST /requests (submit)', () => {
    it('returns 400 for a malformed Idempotency-Key', async () => {
      await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .set('Idempotency-Key', 'not-a-uuid')
        .send(submitBody())
        .expect(400);
    });

    it('creates a request on first call and replays on second call (same key+body → 201)', async () => {
      const idempotencyKey = randomUUID();
      const body = submitBody();

      // First call — creates the request.
      const first = await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      const firstBody = first.body as RequestResponse;
      expect(firstBody.status).toBe('SUBMITTED');

      // Count idempotency records before second call.
      const recordsBefore = await ctx.dataSource
        .getRepository(IdempotencyRecord)
        .findBy({ key: idempotencyKey });
      expect(recordsBefore).toHaveLength(1);

      // Second call — same key + same body → replay, no new DB row, same body.
      const second = await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201);

      const secondBody = second.body as RequestResponse;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.status).toBe('SUBMITTED');

      // Still only one idempotency record (no second insert).
      const recordsAfter = await ctx.dataSource
        .getRepository(IdempotencyRecord)
        .findBy({ key: idempotencyKey });
      expect(recordsAfter).toHaveLength(1);
    });

    it('returns 409 conflict when same key is used with different body', async () => {
      const idempotencyKey = randomUUID();

      // First call.
      await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_2', ['EMPLOYEE']))
        .set('Idempotency-Key', idempotencyKey)
        .send(submitBody())
        .expect(201);

      // Second call with different body (different days_requested).
      const conflictRes = await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_2', ['EMPLOYEE']))
        .set('Idempotency-Key', idempotencyKey)
        .send({ ...submitBody(), days_requested: 5 })
        .expect(409);

      expect(conflictRes.body).toMatchObject({
        type: 'https://api.wizdaa.dev/errors/idempotency-conflict',
        status: 409,
      });
    });

    it('works without an Idempotency-Key (pass-through)', async () => {
      await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_3', ['EMPLOYEE']))
        .send(submitBody())
        .expect(201);
    });
  });

  describe('POST /requests/:id/approve', () => {
    let requestId: string;

    beforeAll(async () => {
      // Pre-create a submitted request for approve replay tests.
      const res = await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .send({
          location_id: 'loc_idem',
          start_date: '2027-09-01',
          end_date: '2027-09-03',
          days_requested: 2,
        })
        .expect(201);
      requestId = (res.body as RequestResponse).id;
    });

    it('returns 202 on first approve and replays on second (same key)', async () => {
      const idempotencyKey = randomUUID();

      const first = await request(ctx.httpServer)
        .post(`/api/v1/requests/${requestId}/approve`)
        .set('Authorization', bearer('emp_idem_mgr', ['MANAGER']))
        .set('Idempotency-Key', idempotencyKey)
        .expect(202);

      const firstBody = first.body as RequestResponse;

      const second = await request(ctx.httpServer)
        .post(`/api/v1/requests/${requestId}/approve`)
        .set('Authorization', bearer('emp_idem_mgr', ['MANAGER']))
        .set('Idempotency-Key', idempotencyKey)
        .expect(202);

      const secondBody = second.body as RequestResponse;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.status).toBe(firstBody.status);

      // Only one record in the idempotency table for this key.
      const records = await ctx.dataSource
        .getRepository(IdempotencyRecord)
        .findBy({ key: idempotencyKey });
      expect(records).toHaveLength(1);
    });
  });

  describe('POST /requests/:id/cancel (SUBMITTED → synchronous path)', () => {
    let requestId: string;

    beforeAll(async () => {
      const res = await request(ctx.httpServer)
        .post('/api/v1/requests')
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .send({
          location_id: 'loc_idem',
          start_date: '2027-10-01',
          end_date: '2027-10-03',
          days_requested: 2,
        })
        .expect(201);
      requestId = (res.body as RequestResponse).id;
    });

    it('returns 200 on first cancel and replays on second (same key)', async () => {
      const idempotencyKey = randomUUID();

      const first = await request(ctx.httpServer)
        .post(`/api/v1/requests/${requestId}/cancel`)
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      const firstBody = first.body as RequestResponse;
      expect(firstBody.status).toBe('CANCELLED');

      const second = await request(ctx.httpServer)
        .post(`/api/v1/requests/${requestId}/cancel`)
        .set('Authorization', bearer('emp_idem_1', ['EMPLOYEE']))
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      const secondBody = second.body as RequestResponse;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.status).toBe('CANCELLED');

      const records = await ctx.dataSource
        .getRepository(IdempotencyRecord)
        .findBy({ key: idempotencyKey });
      expect(records).toHaveLength(1);
    });
  });
});

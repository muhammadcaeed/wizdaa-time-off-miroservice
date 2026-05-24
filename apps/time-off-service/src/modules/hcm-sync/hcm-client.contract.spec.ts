import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MockHcmModule } from '../../../../mock-hcm/src/mock-hcm.module';
import { HcmClient } from './hcm-client';
import { HcmArithmeticMismatchError } from './hcm.errors';

/**
 * Contract layer: drives the real {@link HcmClient} over HTTP against the
 * in-process mock HCM (independent DTOs), per test-strategy.md §1.
 *
 * @req REQ-SYNC-01
 * @req REQ-SYNC-02
 * @req REQ-SYNC-03
 */
describe('HcmClient (contract against mock HCM)', () => {
  let mock: INestApplication;
  let client: HcmClient;

  const EMP = 'emp_c01';
  const LOC = 'loc_c01';

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    client = new HcmClient(await mock.getUrl(), 5000);
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    await request(mock.getHttpServer()).post('/mock/control/reset').expect(201);
    await request(mock.getHttpServer())
      .post('/mock/control/balances')
      .send({ employee_id: EMP, location_id: LOC, total_days: 20 });
  });

  it('sends the correct body + Idempotency-Key and returns the verified decrement', async () => {
    const result = await client.adjustBalance({
      employeeId: EMP,
      locationId: LOC,
      delta: -5,
      idempotencyKey: 'req_c1:decrement',
      expectedPreTotal: 20,
      sourceReference: 'request:req_c1',
    });

    expect(result.newTotalDays).toBe(15);
    expect(result.correlationId).toBeTruthy();

    const state = await request(mock.getHttpServer()).get('/mock/control/state').expect(200);
    const body = state.body as { idempotencyKeys: string[] };
    expect(body.idempotencyKeys).toContain('req_c1:decrement');
  });

  it('throws HcmArithmeticMismatchError under the unverifiable-success scenario (F-04)', async () => {
    await request(mock.getHttpServer())
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'unverifiable-success' } });

    await expect(
      client.adjustBalance({
        employeeId: EMP,
        locationId: LOC,
        delta: -5,
        idempotencyKey: 'req_c2:decrement',
        expectedPreTotal: 20,
        sourceReference: 'request:req_c2',
      }),
    ).rejects.toBeInstanceOf(HcmArithmeticMismatchError);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { MockHcmModule } from '../../../../mock-hcm/src/mock-hcm.module';
import { HcmClient } from './hcm-client';
import {
  HcmArithmeticMismatchError,
  HcmServerError,
  HcmTimeoutError,
  HcmTransportError,
} from './hcm.errors';

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
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/reset')
      .expect(201);
    await request(mock.getHttpServer() as Server)
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

    const state = await request(mock.getHttpServer() as Server)
      .get('/mock/control/state')
      .expect(200);
    const body = state.body as { idempotencyKeys: string[] };
    expect(body.idempotencyKeys).toContain('req_c1:decrement');
  });

  it('throws HcmArithmeticMismatchError under the unverifiable-success scenario (F-04)', async () => {
    await request(mock.getHttpServer() as Server)
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

  /**
   * Failure-mode taxonomy over real HTTP: the client must map each transport
   * outcome to the distinct error the retry/breaker policy branches on.
   *
   * @req REQ-DEF-07
   */
  it('maps an HCM 5xx to HcmServerError (F-03)', async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'down' } });

    await expect(adjust('req_c3')).rejects.toBeInstanceOf(HcmServerError);
  });

  it('maps a transport-level connection failure to HcmTransportError (F-01)', async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'network-failure' } });

    await expect(adjust('req_c4')).rejects.toBeInstanceOf(HcmTransportError);
  });

  it('maps a client-timeout against a slow HCM to HcmTimeoutError (F-02)', async () => {
    await request(mock.getHttpServer() as Server)
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'slow' } }); // default 2000ms latency
    const impatient = new HcmClient(await mock.getUrl(), 50);

    await expect(
      impatient.adjustBalance({
        employeeId: EMP,
        locationId: LOC,
        delta: -5,
        idempotencyKey: 'req_c5:decrement',
        expectedPreTotal: 20,
        sourceReference: 'request:req_c5',
      }),
    ).rejects.toBeInstanceOf(HcmTimeoutError);
  });

  /** Single-attempt adjust helper for the failure-mode cases. */
  function adjust(reqId: string): Promise<unknown> {
    return client.adjustBalance({
      employeeId: EMP,
      locationId: LOC,
      delta: -5,
      idempotencyKey: `${reqId}:decrement`,
      expectedPreTotal: 20,
      sourceReference: `request:${reqId}`,
    });
  }
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MockHcmModule } from '../../../../mock-hcm/src/mock-hcm.module';
import { HcmReaderClient } from './hcm-reader-client';
import { HcmServerError } from './hcm.errors';

/**
 * Contract layer: drives the real {@link HcmReaderClient} over HTTP against the
 * in-process mock HCM (independent DTOs), per test-strategy.md §1.
 *
 * @req REQ-REC-01
 */
describe('HcmReaderClient (contract against mock HCM)', () => {
  let mock: INestApplication;
  let client: HcmReaderClient;

  const EMP = 'emp_r01';
  const LOC_A = 'loc_r0a';
  const LOC_B = 'loc_r0b';
  // Explicit, distinct timestamps so batch ordering is deterministic (no ms ties).
  const TS_A = '2026-05-20T10:00:00.000Z';
  const TS_B = '2026-05-21T10:00:00.000Z';
  const SINCE = new Date('2026-05-19T00:00:00.000Z');

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    client = new HcmReaderClient(await mock.getUrl(), 5000);
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    await request(mock.getHttpServer()).post('/mock/control/reset').expect(201);
  });

  it('getBalances maps the employee rows to the camelCase shape', async () => {
    await inject(EMP, LOC_A, 20, TS_A);
    await inject(EMP, LOC_B, 5, TS_B);

    const rows = await client.getBalances(EMP);

    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      employeeId: EMP,
      locationId: LOC_A,
      totalDays: 20,
      lastModifiedAt: TS_A,
    });
    expect(rows).toContainEqual({
      employeeId: EMP,
      locationId: LOC_B,
      totalDays: 5,
      lastModifiedAt: TS_B,
    });
  });

  it('getBalances returns [] for an unknown employee (404 path)', async () => {
    await expect(client.getBalances('emp_unknown')).resolves.toEqual([]);
  });

  it('getBatch returns rows at/after since in the paginated envelope', async () => {
    await inject(EMP, LOC_A, 20, TS_A);
    await inject(EMP, LOC_B, 5, TS_B);

    const page = await client.getBatch(SINCE);

    // Corpus < 50 rows, so a single page drains it fully.
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.rows).toContainEqual({
      employeeId: EMP,
      locationId: LOC_A,
      totalDays: 20,
      lastModifiedAt: TS_A,
    });
    expect(page.rows).toContainEqual({
      employeeId: EMP,
      locationId: LOC_B,
      totalDays: 5,
      lastModifiedAt: TS_B,
    });
  });

  it('getBatch does not surface a drifted row whose last_modified_at was not advanced', async () => {
    await inject(EMP, LOC_A, 20, TS_A);
    await inject(EMP, LOC_B, 5, TS_B);
    // Silently drift LOC_A: total changes but last_modified_at stays at TS_A.
    // A sweep that has already advanced past TS_A (since strictly after it) must
    // NOT re-discover the change — that omission is what the drift check covers.
    const driftedTotal = 999;
    await request(mock.getHttpServer())
      .post('/mock/control/drift')
      .send({ employee_id: EMP, location_id: LOC_A, total_days: driftedTotal })
      .expect(201);

    // since between TS_A and TS_B: LOC_B surfaces, the drifted LOC_A does not.
    const page = await client.getBatch(new Date('2026-05-20T12:00:00.000Z'));

    const ours = page.rows.filter((row) => row.employeeId === EMP);
    expect(ours).toContainEqual({
      employeeId: EMP,
      locationId: LOC_B,
      totalDays: 5,
      lastModifiedAt: TS_B,
    });
    expect(ours.map((row) => row.locationId)).not.toContain(LOC_A);
    expect(ours.map((row) => row.totalDays)).not.toContain(driftedTotal);
  });

  it('getBatch maps an HCM 5xx (down scenario) to HcmServerError', async () => {
    await request(mock.getHttpServer())
      .post('/mock/control/scenarios')
      .send({ endpoints: { batch: 'down' } });

    await expect(client.getBatch(SINCE)).rejects.toBeInstanceOf(HcmServerError);
  });

  it('getBalances maps an HCM 5xx (down scenario) to HcmServerError', async () => {
    await inject(EMP, LOC_A, 20, TS_A);
    await request(mock.getHttpServer())
      .post('/mock/control/scenarios')
      .send({ endpoints: { get_balance: 'down' } });

    await expect(client.getBalances(EMP)).rejects.toBeInstanceOf(HcmServerError);
  });

  /** Injects a stored balance via the mock control plane. */
  function inject(
    employeeId: string,
    locationId: string,
    totalDays: number,
    lastModifiedAt: string,
  ): Promise<unknown> {
    return request(mock.getHttpServer()).post('/mock/control/balances').send({
      employee_id: employeeId,
      location_id: locationId,
      total_days: totalDays,
      last_modified_at: lastModifiedAt,
    });
  }
});

import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bearer } from '../../../test/support/auth';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { AuditLog, Balance, Employee, Location, TimeOffRequest } from '../src/database/entities';
import { Reconciliation } from '../src/database/entities/reconciliation.entity';
import { CircuitBreaker } from '../src/modules/hcm-sync/circuit-breaker';
import { DriftDetectionService } from '../src/modules/reconciliation/drift-detection.service';
import {
  POINT_RECONCILIATION_QUEUE,
  type PointReconciliationQueue,
} from '../src/modules/reconciliation/point-reconciliation-queue';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
import type { RequestResponse } from '../src/modules/time-off/dto/request-response.dto';
import type { ReconciliationResponse } from '../src/modules/reconciliation/dto/reconciliation-response.dto';

/**
 * Reconciliation HTTP surface, post-commit drift, and the F-05 enqueue, driven
 * over HTTP through the real resilience stack against an in-process mock HCM.
 *
 * @req REQ-SYNC-04a
 * @req REQ-SYNC-08
 * @req REQ-REC-04
 * @req REQ-REC-06
 */
describe('Reconciliation surface, post-commit drift, and F-05 enqueue (e2e)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;
  let driftDetection: DriftDetectionService;
  let pointQueue: PointReconciliationQueue & { drain(): Promise<void> };

  const LOC = 'loc_001';
  const MGR = 'mgr_001';

  const adminAuth = bearer('admin_1', ['ADMIN']);
  const mgrAuth = bearer(MGR, ['MANAGER']);

  /** Drains the drift checker then the point queue: drift schedules an enqueue that itself schedules reconcilePoint. */
  async function drainPipeline(): Promise<void> {
    await driftDetection.drain();
    await pointQueue.drain();
  }

  async function seedEmployee(id: string, total: number, reserved: number): Promise<void> {
    await ctx.dataSource.getRepository(Employee).insert({
      id,
      email: `${id}@x.io`,
      firstName: 'E',
      lastName: 'O',
      locationId: LOC,
      managerId: MGR,
    });
    await ctx.dataSource.getRepository(Balance).insert({
      id: `bal_${id}`,
      employeeId: id,
      locationId: LOC,
      totalDays: total,
      reservedDays: reserved,
      version: 0,
    });
    await request(mock.getHttpServer())
      .post('/mock/control/balances')
      .send({ employee_id: id, location_id: LOC, total_days: total });
  }

  async function seedRequest(id: string, employeeId: string, days: number): Promise<void> {
    await ctx.dataSource.getRepository(TimeOffRequest).insert({
      id,
      employeeId,
      locationId: LOC,
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      daysRequested: days,
      status: 'SUBMITTED',
      submittedAt: new Date(),
    });
  }

  const approve = (reqId: string) =>
    request(ctx.httpServer)
      .post(`/api/v1/requests/${reqId}/approve`)
      .set('Authorization', mgrAuth)
      .set('Idempotency-Key', randomUUID());

  /** Count of adjust calls the client has made, from the mock's call log. */
  async function adjustCallCount(): Promise<number> {
    const res = await request(mock.getHttpServer()).get('/mock/control/calls').expect(200);
    const body = res.body as { calls: { path: string }[] };
    return body.calls.filter((c) => c.path.includes('/hcm/balances/adjust')).length;
  }

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmBaseUrl: await mock.getUrl() });
    driftDetection = ctx.app.get(DriftDetectionService);
    pointQueue = ctx.app.get(POINT_RECONCILIATION_QUEUE);

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('post-commit drift detection audits the drift and runs a point recon end-to-end, never rolling back APPROVED (REQ-SYNC-04a)', async () => {
    // The saga calls driftDetection.scheduleDriftCheck after a successful APPROVED
    // commit (asserted in the saga unit spec). A successful approve cannot itself
    // produce post-commit drift here: the saga's defensive arithmetic check
    // (expectedPreTotal + delta) already rejects any HCM-vs-local divergence at
    // adjust time as F-04. Genuine post-commit drift models an HCM-side edit that
    // happens strictly AFTER the commit; to exercise that deterministically we
    // approve cleanly, then drift HCM, then invoke the same scheduleDriftCheck the
    // saga invokes — the production code path, with the divergence present at read.
    await seedEmployee('emp_drift', 10, 3);
    await seedRequest('req_drift', 'emp_drift', 3);

    const res = await approve('req_drift').expect(202);
    expect((res.body as RequestResponse).status).toBe('APPROVED');
    // Drain the saga's own (no-drift) check so it doesn't bleed into the assertions.
    await drainPipeline();

    // Silently drift the HCM total away from the committed local total (7 -> 99),
    // modeling an independent HCM-side edit after the commit.
    await request(mock.getHttpServer())
      .post('/mock/control/drift')
      .send({ employee_id: 'emp_drift', location_id: LOC, total_days: 99 })
      .expect(201);

    driftDetection.scheduleDriftCheck('emp_drift', LOC, 'decrement', 7, 'req_drift', 'corr_drift');
    await drainPipeline();

    const drift = await ctx.dataSource
      .getRepository(AuditLog)
      .findOneByOrFail({ action: 'hcm.decrement.drift_detected', entityId: 'req_drift' });
    expect(drift.metadata).toMatchObject({ localTotal: 7, hcmTotal: 99, deltaObserved: 92 });

    // The point recon ran: HCM (99) wins, local total reconciled to 99.
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_drift' });
    expect(balance.totalDays).toBe(99);

    // The committed transition is untouched — drift never rolls back.
    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_drift' });
    expect(req.status).toBe('APPROVED');
  });

  it('fails F-05 to APPROVAL_FAILED, enqueues a point recon, and creates no batch run (REQ-SYNC-08)', async () => {
    // Local available is 5 (total 5, reserved 0), but HCM has only 2 — a 3-day
    // decrement underflows HCM, which 409s insufficient_balance.
    await seedEmployee('emp_f05', 5, 0);
    await ctx.dataSource
      .getRepository(Balance)
      .update({ id: 'bal_emp_f05' }, { totalDays: 5, reservedDays: 0 });
    // HCM holds only 2: a 3-day decrement drives it to -1, triggering the 409.
    await request(mock.getHttpServer())
      .post('/mock/control/balances')
      .send({ employee_id: 'emp_f05', location_id: LOC, total_days: 2 });
    await seedRequest('req_f05', 'emp_f05', 3);

    const runsBefore = (
      await request(ctx.httpServer)
        .get('/api/v1/reconciliations')
        .set('Authorization', adminAuth)
        .expect(200)
    ).body as { data: ReconciliationResponse[] };

    const adjustsBefore = await adjustCallCount();
    const res = await approve('req_f05').expect(202);
    const body = res.body as RequestResponse;
    expect(body.status).toBe('APPROVAL_FAILED');
    expect(body.failure_reason).toBe('hcm_insufficient_balance');
    // F-05 is not retryable: exactly one adjust call, no retry budget burned.
    expect((await adjustCallCount()) - adjustsBefore).toBe(1);

    await pointQueue.drain();

    // A point recon refreshed the local total from HCM (5 -> 2); reservation released.
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_f05' });
    expect(balance.totalDays).toBe(2);

    // No full batch Reconciliation row was created for a single-balance event.
    const runsAfter = (
      await request(ctx.httpServer)
        .get('/api/v1/reconciliations')
        .set('Authorization', adminAuth)
        .expect(200)
    ).body as { data: ReconciliationResponse[] };
    expect(runsAfter.data.length).toBe(runsBefore.data.length);
  });

  it('returns 409 reconciliation-in-progress when a run is already RUNNING (REQ-REC-06)', async () => {
    // Insert a RUNNING row directly to hold the partial UNIQUE slot.
    await ctx.dataSource.getRepository(Reconciliation).insert({
      id: '99999999-9999-9999-9999-999999999999',
      status: 'RUNNING',
      since: new Date(0),
      startedAt: new Date(),
      completedAt: null,
      balancesExamined: 0,
      conflicts: 0,
      triggerType: 'SCHEDULED',
    });
    try {
      const res = await request(ctx.httpServer)
        .post('/api/v1/reconciliations')
        .set('Authorization', adminAuth)
        .set('Idempotency-Key', randomUUID())
        .expect(409);
      expect((res.body as { type: string }).type).toBe('/errors/reconciliation-in-progress');
    } finally {
      await ctx.dataSource
        .getRepository(Reconciliation)
        .delete({ id: '99999999-9999-9999-9999-999999999999' });
    }
  });

  it('triggers a run and reads it back COMPLETED with conflict count and completed_at (REQ-REC-04)', async () => {
    const triggered = await request(ctx.httpServer)
      .post('/api/v1/reconciliations')
      .set('Authorization', adminAuth)
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    const run = triggered.body as ReconciliationResponse;
    expect(['COMPLETED', 'COMPLETED_WITH_CONFLICTS']).toContain(run.status);

    const fetched = await request(ctx.httpServer)
      .get(`/api/v1/reconciliations/${run.id}`)
      .set('Authorization', adminAuth)
      .expect(200);
    const body = fetched.body as ReconciliationResponse;
    expect(body.id).toBe(run.id);
    expect(['COMPLETED', 'COMPLETED_WITH_CONFLICTS']).toContain(body.status);
    expect(body.completed_at).not.toBeNull();
    expect(typeof body.conflicts).toBe('number');
  });

  it('404s a reconciliation read for an unknown id', async () => {
    const res = await request(ctx.httpServer)
      .get('/api/v1/reconciliations/00000000-0000-0000-0000-000000000000')
      .set('Authorization', adminAuth)
      .expect(404);
    expect((res.body as { type: string }).type).toBe('/errors/reconciliation-not-found');
  });

  it('forbids non-admins from the reconciliation surface', async () => {
    await request(ctx.httpServer)
      .get('/api/v1/reconciliations')
      .set('Authorization', mgrAuth)
      .expect(403);
  });

  it('400s a list request with a malformed cursor', async () => {
    const res = await request(ctx.httpServer)
      .get('/api/v1/reconciliations?cursor=not-a-valid-cursor')
      .set('Authorization', adminAuth)
      .expect(400);
    expect((res.body as { type: string }).type).toBe('/errors/invalid-cursor');
  });
});

/**
 * Breaker-open behavior for the scheduled batch run, driven directly on the
 * service (no real timer; the scheduler suppresses itself under NODE_ENV=test).
 *
 * @req REQ-REC-01
 */
describe('runScheduled breaker-open skip (integration)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmBaseUrl: await mock.getUrl() });
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('creates no Reconciliation row when the breaker is hard-OPEN', async () => {
    const breaker = ctx.app.get(CircuitBreaker);
    // Trip the breaker to OPEN (5 consecutive failures crosses the threshold).
    for (let i = 0; i < 5; i++) breaker.recordFailure();
    expect(breaker.isHardOpen()).toBe(true);

    const service = ctx.app.get(ReconciliationService);
    await service.runScheduled();

    const count = await ctx.dataSource.getRepository(Reconciliation).count();
    expect(count).toBe(0);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bootstrapE2E, type E2EContext } from '../../../test/support/e2e';
import { MockHcmModule } from '../../mock-hcm/src/mock-hcm.module';
import { AuditLog, Balance, Employee, Location, TimeOffRequest } from '../src/database/entities';
import { HcmClient } from '../src/modules/hcm-sync/hcm-client';
import { CircuitBreaker } from '../src/modules/hcm-sync/circuit-breaker';
import { StuckStateSweepService } from '../src/modules/time-off/stuck-state-sweep.service';

/**
 * Stuck-state sweep e2e tests (REQ-DEF-11, REQ-DEF-12, F-07, TRD §11.1).
 *
 * Uses the real mock HCM as the HCM backend, bootstrapped independently per
 * describe-block so breaker state cannot leak across suites. The scheduler is
 * suppressed (NODE_ENV=test), and `runSweep()` is called directly.
 *
 * @req REQ-DEF-11
 * @req REQ-DEF-12
 */

const LOC = 'loc_001';
const MGR = 'mgr_001';
const FUTURE_START = '2030-01-01';
const FUTURE_END = '2030-01-03';

/** Seeds an employee + local balance and the mirrored mock-HCM balance. */
async function seedEmployee(
  ctx: E2EContext,
  mock: INestApplication,
  id: string,
  totalDays: number,
  reservedDays: number,
): Promise<void> {
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
    totalDays,
    reservedDays,
    version: 0,
  });
  await request(mock.getHttpServer())
    .post('/mock/control/balances')
    .send({ employee_id: id, location_id: LOC, total_days: totalDays });
}

/**
 * Directly inserts a TimeOffRequest row in a stuck transient state with an
 * `updatedAt` far in the past (beyond the threshold) to ensure the sweep
 * picks it up.
 */
async function seedStuckRequest(
  ctx: E2EContext,
  id: string,
  employeeId: string,
  status: 'APPROVING' | 'CANCELLING',
  days: number,
): Promise<void> {
  const stuckUpdatedAt = new Date(Date.now() - 600_000); // 10 minutes ago, well past threshold
  await ctx.dataSource.manager
    .createQueryBuilder()
    .insert()
    .into(TimeOffRequest)
    .values({
      id,
      employeeId,
      locationId: LOC,
      startDate: FUTURE_START,
      endDate: FUTURE_END,
      daysRequested: days,
      status,
      submittedAt: new Date(),
    })
    .execute();
  // Back-date `updated_at` so the sweep's LessThan(cutoff) predicate matches.
  await ctx.dataSource.manager
    .createQueryBuilder()
    .update(TimeOffRequest)
    .set({ updatedAt: stuckUpdatedAt })
    .where('id = :id', { id })
    .execute();
}

// ---------------------------------------------------------------------------
// Suite 1: Stuck APPROVING — HCM confirms (idempotent replay case 1)
// ---------------------------------------------------------------------------
describe('Stuck-state sweep: APPROVING → APPROVED (case 1, HCM confirms)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;
  let sweep: StuckStateSweepService;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });

    sweep = ctx.app.get(StuckStateSweepService);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('resolves a stuck APPROVING row to APPROVED and records lifecycle.recovery.committed (F-07, REQ-DEF-11)', async () => {
    await seedEmployee(ctx, mock, 'emp_sw1', 10, 3);

    // The mock HCM starts with total_days=10. We simulate an approval saga that
    // crashed between phase 1 and phase 3:
    // - Phase 1 completed: APPROVING status, reservation held (balance=10, reserved=3).
    // - Phase 2 (HCM decrement) completed: HCM has total_days=7 stored under the key.
    // - Phase 3 crashed: local balance still shows 10 (delta not committed).
    //
    // Simulate by directly adjusting the mock HCM (so the idempotency key is stored)
    // and leaving the local DB untouched (total=10, reserved=3).
    const reqId = 'req_sw1';
    const idempotencyKey = `${reqId}:decrement`;
    // Make HCM think it already applied the decrement (stores idempotency key).
    await request(mock.getHttpServer())
      .post('/hcm/balances/adjust')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        employee_id: 'emp_sw1',
        location_id: LOC,
        delta: -3,
        operation_type: 'DECREMENT',
        source_reference: `request:${reqId}`,
      })
      .expect(200);
    // Now mock HCM has total=7 and the idempotency key stored.

    // Seed the stuck APPROVING row (local total still 10, reserved 3).
    await seedStuckRequest(ctx, reqId, 'emp_sw1', 'APPROVING', 3);

    await sweep.runSweep();

    // Verify the request is now APPROVED.
    const req = await ctx.dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: reqId });
    expect(req.status).toBe('APPROVED');

    // Local balance should reflect the decrement: total 10→7, reserved 3→0.
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_sw1' });
    expect(balance.totalDays).toBe(7);
    expect(balance.reservedDays).toBe(0);

    // Audit trail has the recovery committed entry.
    const auditLog = ctx.dataSource.getRepository(AuditLog);
    const recoveryAudit = await auditLog.findOneBy({
      action: 'lifecycle.recovery.committed',
      entityId: reqId,
    });
    expect(recoveryAudit).not.toBeNull();
    expect((recoveryAudit!.afterState as { status: string }).status).toBe('APPROVED');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Stuck APPROVING — HCM has no record (fresh decrement, case 1 again)
// ---------------------------------------------------------------------------
describe('Stuck-state sweep: APPROVING → APPROVAL_FAILED (HCM returns error)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;
  let sweep: StuckStateSweepService;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });

    sweep = ctx.app.get(StuckStateSweepService);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('transitions stuck APPROVING to APPROVAL_FAILED and records lifecycle.recovery.failed when HCM is down (REQ-DEF-11)', async () => {
    await seedEmployee(ctx, mock, 'emp_sw2', 10, 3);
    const reqId = 'req_sw2';

    // No prior HCM call: HCM does not have the idempotency key.
    // The mock HCM is set to `down` so the sweep gets a transport error,
    // which drives the APPROVING→APPROVAL_FAILED transition.
    await request(mock.getHttpServer())
      .post('/mock/control/scenarios')
      .send({ endpoints: { adjust: 'down' }, scope: { employee_id: 'emp_sw2' } });

    await seedStuckRequest(ctx, reqId, 'emp_sw2', 'APPROVING', 3);

    await sweep.runSweep();

    const req = await ctx.dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: reqId });
    expect(req.status).toBe('APPROVAL_FAILED');
    expect(req.failureReason).toBeTruthy();

    // Reservation should be released (balance.reservedDays -= 3).
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_sw2' });
    // total unchanged (HCM never applied the decrement).
    expect(balance.totalDays).toBe(10);
    expect(balance.reservedDays).toBe(0);

    // Audit trail has the recovery failed entry.
    const recoveryAudit = await ctx.dataSource.getRepository(AuditLog).findOneBy({
      action: 'lifecycle.recovery.failed',
      entityId: reqId,
    });
    expect(recoveryAudit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Breaker OPEN — sweep skips all rows, no HCM calls (REQ-DEF-12)
// ---------------------------------------------------------------------------
describe('Stuck-state sweep: breaker OPEN → sweep skipped entirely (REQ-DEF-12)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;
  let sweep: StuckStateSweepService;
  let breaker: CircuitBreaker;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmBaseUrl: await mock.getUrl() });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });

    sweep = ctx.app.get(StuckStateSweepService);
    breaker = ctx.app.get(CircuitBreaker);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('skips all stuck rows and makes no HCM calls when the breaker is hard-OPEN (REQ-DEF-12)', async () => {
    await seedEmployee(ctx, mock, 'emp_sw3', 10, 3);
    await seedStuckRequest(ctx, 'req_sw3', 'emp_sw3', 'APPROVING', 3);

    // Trip the breaker to hard-OPEN.
    for (let i = 0; i < 5; i++) breaker.recordFailure();
    expect(breaker.isHardOpen()).toBe(true);

    const callsBefore = (await request(mock.getHttpServer()).get('/mock/control/calls').expect(200))
      .body as { calls: { path: string }[] };
    const adjustsBefore = callsBefore.calls.filter((c) =>
      c.path.includes('/hcm/balances/adjust'),
    ).length;

    await sweep.runSweep();

    // Row must still be APPROVING (sweep skipped).
    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_sw3' });
    expect(req.status).toBe('APPROVING');

    // No new HCM adjust calls made.
    const callsAfter = (await request(mock.getHttpServer()).get('/mock/control/calls').expect(200))
      .body as { calls: { path: string }[] };
    const adjustsAfter = callsAfter.calls.filter((c) =>
      c.path.includes('/hcm/balances/adjust'),
    ).length;
    expect(adjustsAfter).toBe(adjustsBefore);

    // sweep.skipped audit entry recorded.
    const skippedAudit = await ctx.dataSource.getRepository(AuditLog).findOneBy({
      action: 'sweep.skipped',
    });
    expect(skippedAudit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Row within threshold — sweep leaves it alone
// ---------------------------------------------------------------------------
describe('Stuck-state sweep: row within threshold is not touched', () => {
  let mock: INestApplication;
  let ctx: E2EContext;
  let sweep: StuckStateSweepService;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });

    sweep = ctx.app.get(StuckStateSweepService);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('leaves APPROVING row untouched when updatedAt is within the threshold window', async () => {
    await seedEmployee(ctx, mock, 'emp_sw4', 10, 3);

    // Insert an APPROVING row with a recent updatedAt (within the 5-minute threshold).
    await ctx.dataSource.getRepository(TimeOffRequest).insert({
      id: 'req_sw4',
      employeeId: 'emp_sw4',
      locationId: LOC,
      startDate: FUTURE_START,
      endDate: FUTURE_END,
      daysRequested: 3,
      status: 'APPROVING',
      submittedAt: new Date(),
      // updatedAt defaults to NOW via TypeORM @UpdateDateColumn — within threshold.
    });

    await sweep.runSweep();

    // Row must still be APPROVING — it is not yet stuck (within threshold window).
    const req = await ctx.dataSource
      .getRepository(TimeOffRequest)
      .findOneByOrFail({ id: 'req_sw4' });
    expect(req.status).toBe('APPROVING');
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Stuck CANCELLING — HCM confirms (idempotent replay case 1)
// ---------------------------------------------------------------------------
describe('Stuck-state sweep: CANCELLING → CANCELLED (case 1, HCM confirms)', () => {
  let mock: INestApplication;
  let ctx: E2EContext;
  let sweep: StuckStateSweepService;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [MockHcmModule] }).compile();
    mock = ref.createNestApplication();
    await mock.listen(0);
    ctx = await bootstrapE2E({ hcmAdjuster: new HcmClient(await mock.getUrl(), 5000) });

    await ctx.dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
    await ctx.dataSource.getRepository(Employee).insert({
      id: MGR,
      email: 'm@x.io',
      firstName: 'M',
      lastName: 'O',
      locationId: LOC,
      managerId: null,
    });

    sweep = ctx.app.get(StuckStateSweepService);
  });

  afterAll(async () => {
    await ctx.close();
    await mock.close();
  });

  it('resolves a stuck CANCELLING row to CANCELLED and records lifecycle.recovery.committed (F-07, REQ-DEF-11)', async () => {
    // Simulate post-approval state: totalDays=7 (decrement committed), reservedDays=0.
    await seedEmployee(ctx, mock, 'emp_sw5', 7, 0);

    const reqId = 'req_sw5';
    const idempotencyKey = `${reqId}:increment`;

    // Make HCM think it already applied the increment (total: 7→10).
    await request(mock.getHttpServer())
      .post('/hcm/balances/adjust')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        employee_id: 'emp_sw5',
        location_id: LOC,
        delta: 3,
        operation_type: 'INCREMENT',
        source_reference: `request:${reqId}`,
      })
      .expect(200);
    // HCM now has total=10 stored.

    // Seed the stuck CANCELLING row (local total still 7).
    await seedStuckRequest(ctx, reqId, 'emp_sw5', 'CANCELLING', 3);

    await sweep.runSweep();

    const req = await ctx.dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: reqId });
    expect(req.status).toBe('CANCELLED');

    // Local balance should reflect the increment: total 7→10, reserved unchanged (0).
    const balance = await ctx.dataSource
      .getRepository(Balance)
      .findOneByOrFail({ id: 'bal_emp_sw5' });
    expect(balance.totalDays).toBe(10);
    expect(balance.reservedDays).toBe(0);

    // Audit trail has the recovery committed entry.
    const recoveryAudit = await ctx.dataSource.getRepository(AuditLog).findOneBy({
      action: 'lifecycle.recovery.committed',
      entityId: reqId,
    });
    expect(recoveryAudit).not.toBeNull();
    expect((recoveryAudit!.afterState as { status: string }).status).toBe('CANCELLED');
  });
});

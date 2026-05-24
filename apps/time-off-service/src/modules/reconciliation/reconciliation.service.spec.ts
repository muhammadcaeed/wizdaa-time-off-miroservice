import type { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AuditService } from '../../common/audit/audit.service';
import { AuditLog, Balance, Reconciliation } from '../../database/entities';
import { BalanceRepository } from '../balances/balance.repository';
import { CircuitBreaker, type CircuitBreakerConfig } from '../hcm-sync/circuit-breaker';
import type { HcmBalanceRow, HcmBatchPage, HcmReader } from '../hcm-sync/hcm-reader';
import { RequestRepository } from '../time-off/request.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationInProgressError } from '../../common/errors/reconciliation-in-progress.error';

const BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureRate: 0.5,
  cooldownMs: 30_000,
  probeDeadlineMs: 10_000,
};

/** Minimal PinoLogger stand-in; the service only calls `.info`/`.error`. */
function fakeLogger(): PinoLogger {
  return { info: () => undefined, error: () => undefined } as unknown as PinoLogger;
}

/** Scriptable {@link HcmReader}: one batch page and a per-employee point read. */
class FakeHcmReader implements HcmReader {
  constructor(
    private readonly batchRows: HcmBalanceRow[] = [],
    private readonly pointRows: HcmBalanceRow[] = [],
  ) {}

  getBalances(employeeId: string): Promise<HcmBalanceRow[]> {
    return Promise.resolve(this.pointRows.filter((r) => r.employeeId === employeeId));
  }

  getBatch(): Promise<HcmBatchPage> {
    return Promise.resolve({ rows: this.batchRows, nextCursor: null, hasMore: false });
  }
}

const EMP_ID = 'emp_001';
const LOC_ID = 'loc_001';
const BAL_ID = 'bal_001';

/**
 * @req REQ-REC-02
 * @req REQ-REC-03
 * @req REQ-REC-04
 * @req REQ-REC-05
 * @req REQ-REC-06
 */
describe('ReconciliationService (batch + point, TRD §9.3/§9.7)', () => {
  let dataSource: DataSource;
  let balanceRepo: BalanceRepository;
  let requestRepo: RequestRepository;
  let reconRepo: ReconciliationRepository;
  let audit: AuditService;
  let breaker: CircuitBreaker;

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    balanceRepo = new BalanceRepository(dataSource);
    requestRepo = new RequestRepository(dataSource);
    reconRepo = new ReconciliationRepository(dataSource);
    audit = new AuditService(new AuditRepository());
    breaker = new CircuitBreaker(BREAKER_CONFIG, Date.now, fakeLogger());
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  function service(reader: HcmReader): ReconciliationService {
    return new ReconciliationService(
      dataSource,
      reconRepo,
      balanceRepo,
      requestRepo,
      reader,
      breaker,
      audit,
      fakeLogger(),
    );
  }

  async function seedBalance(totalDays: number, reservedDays = 0): Promise<void> {
    await dataSource.getRepository(Balance).insert({
      id: BAL_ID,
      employeeId: EMP_ID,
      locationId: LOC_ID,
      totalDays,
      reservedDays,
      version: 0,
    });
  }

  async function seedReservingRequest(days: number): Promise<void> {
    await requestRepo.insert(
      {
        id: 'req_001',
        employeeId: EMP_ID,
        locationId: LOC_ID,
        startDate: '2026-07-01',
        endDate: '2026-07-05',
        daysRequested: days,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
      dataSource.manager,
    );
  }

  function hcmRow(totalDays: number): HcmBalanceRow {
    return {
      employeeId: EMP_ID,
      locationId: LOC_ID,
      totalDays,
      lastModifiedAt: '2026-05-24T00:00:00Z',
    };
  }

  function auditActions(): Promise<string[]> {
    return dataSource
      .getRepository(AuditLog)
      .find({ order: { timestamp: 'ASC' } })
      .then((rows) => rows.map((r) => r.action));
  }

  it('REQ-REC-02: safe drift updates local total, bumps version, stamps sync, audits, run COMPLETED', async () => {
    await seedBalance(20);
    await seedReservingRequest(5); // reserved=5, hcm=25 -> 25-5>=0 safe

    const run = await service(new FakeHcmReader([hcmRow(25)])).runOnDemand();

    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(25);
    expect(after?.reservedDays).toBe(5);
    expect(after?.version).toBe(1);
    expect(after?.lastHcmSyncAt).not.toBeNull();
    expect(await auditActions()).toEqual(['balance.reconciled']);
    expect(run.status).toBe('COMPLETED');
    expect(run.balancesExamined).toBe(1);
    expect(run.conflicts).toBe(0);
    expect(run.completedAt).not.toBeNull();
  });

  it('REQ-REC-03: unsafe drift (hcm < reserved) leaves balance, audits conflict, run COMPLETED_WITH_CONFLICTS', async () => {
    await seedBalance(20);
    await seedReservingRequest(15); // reserved=15, hcm=10 -> 10-15<0 unsafe

    const run = await service(new FakeHcmReader([hcmRow(10)])).runOnDemand();

    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(20);
    expect(after?.version).toBe(0);
    expect(await auditActions()).toEqual(['balance.reconciliation.conflict']);
    expect(run.status).toBe('COMPLETED_WITH_CONFLICTS');
    expect(run.conflicts).toBe(1);
  });

  it('no-drift: equal totals touch last_hcm_sync_at only, no version bump, no reconciled audit', async () => {
    await seedBalance(20);

    const run = await service(new FakeHcmReader([hcmRow(20)])).runOnDemand();

    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(20);
    expect(after?.version).toBe(0);
    expect(after?.lastHcmSyncAt).not.toBeNull();
    expect(await auditActions()).toEqual([]);
    expect(run.status).toBe('COMPLETED');
    expect(run.balancesExamined).toBe(1);
  });

  it('skips an HCM row with no local balance: no balance created, no audit', async () => {
    // No seedBalance: the (employee, location) is unknown locally.
    const run = await service(new FakeHcmReader([hcmRow(25)])).runOnDemand();

    expect(await dataSource.getRepository(Balance).count()).toBe(0);
    expect(await auditActions()).toEqual([]);
    expect(run.status).toBe('COMPLETED');
    expect(run.balancesExamined).toBe(1);
  });

  it('REQ-REC-05: idempotent — re-running the same corpus is a no-op on the second pass', async () => {
    await seedBalance(20);
    const reader = new FakeHcmReader([hcmRow(25)]);

    const first = await service(reader).runOnDemand();
    const afterFirst = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(afterFirst?.totalDays).toBe(25);
    expect(afterFirst?.version).toBe(1);
    expect(first.status).toBe('COMPLETED');

    const second = await service(reader).runOnDemand();
    const afterSecond = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(afterSecond?.totalDays).toBe(25);
    expect(afterSecond?.version).toBe(1); // unchanged: equal totals on the second pass
    expect(second.status).toBe('COMPLETED');
    // First run reconciled once; second run audited nothing.
    expect(await auditActions()).toEqual(['balance.reconciled']);
  });

  it('REQ-REC-06: a second RUNNING run is refused with ReconciliationInProgressError', async () => {
    await dataSource.transaction((m) => reconRepo.createRunning(new Date(0), 'SCHEDULED', m));

    await expect(
      dataSource.transaction((m) => reconRepo.createRunning(new Date(0), 'ON_DEMAND', m)),
    ).rejects.toBeInstanceOf(ReconciliationInProgressError);
  });

  it('breaker OPEN: runScheduled creates NO reconciliation row and returns', async () => {
    await seedBalance(20);
    // Trip then keep OPEN inside cool-down so isHardOpen() is true.
    for (let i = 0; i < BREAKER_CONFIG.failureThreshold; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isHardOpen()).toBe(true);

    await service(new FakeHcmReader([hcmRow(25)])).runScheduled();

    expect(await dataSource.getRepository(Reconciliation).count()).toBe(0);
    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(20); // untouched
  });

  it('point reconciliation: safe drift updates local to HCM total and audits point_reconciled', async () => {
    await seedBalance(20);
    await seedReservingRequest(3);

    await service(new FakeHcmReader([], [hcmRow(30)])).reconcilePoint(EMP_ID, LOC_ID);

    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(30);
    expect(after?.reservedDays).toBe(3);
    expect(after?.version).toBe(1);
    expect(await auditActions()).toEqual(['balance.point_reconciled']);
  });

  it('point reconciliation: unsafe drift audits conflict and leaves the balance unchanged', async () => {
    await seedBalance(20);
    await seedReservingRequest(15);

    await service(new FakeHcmReader([], [hcmRow(10)])).reconcilePoint(EMP_ID, LOC_ID);

    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(20);
    expect(after?.version).toBe(0);
    expect(await auditActions()).toEqual(['balance.point_reconciliation.conflict']);
  });

  it('point reconciliation: breaker OPEN is a no-op', async () => {
    await seedBalance(20);
    for (let i = 0; i < BREAKER_CONFIG.failureThreshold; i++) {
      breaker.recordFailure();
    }

    await service(new FakeHcmReader([], [hcmRow(30)])).reconcilePoint(EMP_ID, LOC_ID);

    const after = await balanceRepo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(20);
    expect(await auditActions()).toEqual([]);
  });
});

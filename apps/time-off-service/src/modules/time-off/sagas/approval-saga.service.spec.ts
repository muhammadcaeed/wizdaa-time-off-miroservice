import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../../test/support/db';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { OccConflictError } from '../../../common/persistence/occ-conflict.error';
import { AuditLog, Balance, Employee, TimeOffRequest } from '../../../database/entities';
import { AuthorizationService } from '../../auth/authorization.service';
import { EmployeeRepository } from '../../auth/employee.repository';
import type { Principal } from '../../auth/principal';
import type { PinoLogger } from 'nestjs-pino';
import { CircuitBreaker } from '../../hcm-sync/circuit-breaker';
import type { HcmAdjuster } from '../../hcm-sync/hcm-adjuster';
import { HcmArithmeticMismatchError } from '../../hcm-sync/hcm.errors';
import { BalanceRepository } from '../../balances/balance.repository';
import type { DriftDetectionService } from '../../reconciliation/drift-detection.service';
import type {
  PointReconciliationJob,
  PointReconciliationQueue,
} from '../../reconciliation/point-reconciliation-queue';
import { RequestRepository } from '../request.repository';
import { ApprovalSagaService } from './approval-saga.service';

/**
 * @req REQ-LIFE-03
 * @req REQ-LIFE-04
 * @req REQ-LIFE-05
 * @req REQ-SYNC-03
 * @req REQ-SYNC-05
 * @req INV-03
 */
describe('ApprovalSagaService (forward saga T-02/03/04)', () => {
  let dataSource: DataSource;
  let balanceRepo: BalanceRepository;
  let requestRepo: RequestRepository;

  const manager: Principal = { sub: 'mgr_001', roles: ['MANAGER'] };

  /** Captures point-recon enqueues so the F-04/F-05 wiring can be asserted (REQ-SYNC-04). */
  let enqueued: PointReconciliationJob[];
  /** Captures post-commit drift schedules so the APPROVED wiring can be asserted (REQ-SYNC-04a). */
  let driftScheduled: { employeeId: string; locationId: string; committedTotal: number }[];

  function buildSaga(
    hcm: HcmAdjuster,
    breaker: CircuitBreaker = closedBreaker(),
  ): ApprovalSagaService {
    const queue: PointReconciliationQueue = {
      enqueue: (job) => {
        enqueued.push(job);
      },
    };
    const drift = {
      scheduleDriftCheck: (
        employeeId: string,
        locationId: string,
        _op: 'decrement' | 'increment',
        committedTotal: number,
      ) => {
        driftScheduled.push({ employeeId, locationId, committedTotal });
      },
    } as unknown as DriftDetectionService;
    return new ApprovalSagaService(
      dataSource,
      balanceRepo,
      requestRepo,
      new AuditService(new AuditRepository()),
      new AuthorizationService(new EmployeeRepository(dataSource)),
      hcm,
      breaker,
      queue,
      drift,
    );
  }

  /** A real breaker held CLOSED so the entry pre-gate is a no-op for these specs. */
  function closedBreaker(): CircuitBreaker {
    return new CircuitBreaker(
      { failureThreshold: 5, failureRate: 0.5, cooldownMs: 30_000, probeDeadlineMs: 10_000 },
      Date.now,
      { info: () => undefined } as unknown as PinoLogger,
    );
  }

  beforeEach(async () => {
    enqueued = [];
    driftScheduled = [];
    dataSource = await createTestDataSource();
    balanceRepo = new BalanceRepository(dataSource);
    requestRepo = new RequestRepository(dataSource);
    await dataSource.getRepository(Employee).insert({
      id: 'emp_001',
      email: 'e@x.io',
      firstName: 'E',
      lastName: 'O',
      locationId: 'loc_001',
      managerId: 'mgr_001',
    });
    await dataSource.getRepository(Balance).insert({
      id: 'bal_001',
      employeeId: 'emp_001',
      locationId: 'loc_001',
      totalDays: 10,
      reservedDays: 3,
      version: 0,
    });
    await requestRepo.insert(
      {
        id: 'req_001',
        employeeId: 'emp_001',
        locationId: 'loc_001',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: 3,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
      dataSource.manager,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('commits APPROVED, decrements total + reserved, persists correlation id (T-03)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: ({ expectedPreTotal, delta }) =>
        Promise.resolve({ newTotalDays: expectedPreTotal + delta, correlationId: 'hcm_op_1' }),
    };

    const res = await buildSaga(hcm).execute('req_001', manager);

    expect(res.status).toBe('APPROVED');
    expect(res.hcm_correlation_id).toBe('hcm_op_1');

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.totalDays).toBe(7);
    expect(balance.reservedDays).toBe(0);

    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('request.approving');
    expect(actions).toContain('request.approved');
    expect(actions).toContain('hcm.decrement.confirmed');

    // REQ-SYNC-04a: a successful commit schedules a post-commit drift check
    // against the committed local total (pre 10 + delta -3 = 7).
    expect(driftScheduled).toEqual([
      { employeeId: 'emp_001', locationId: 'loc_001', committedTotal: 7 },
    ]);
  });

  it('fails to APPROVAL_FAILED and releases the reservation on an ambiguous HCM response (T-04, F-04)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: () => Promise.reject(new HcmArithmeticMismatchError('mismatch', 7, 8)),
    };

    const res = await buildSaga(hcm).execute('req_001', manager);

    expect(res.status).toBe('APPROVAL_FAILED');
    expect(res.failure_reason).toBe('hcm_ambiguous');

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.totalDays).toBe(10); // unchanged
    expect(balance.reservedDays).toBe(0); // released

    const rows = await dataSource.getRepository(AuditLog).find();
    const actions = rows.map((a) => a.action);
    expect(actions).toContain('request.approval_failed');
    expect(actions).toContain('hcm.decrement.ambiguous');

    // F-04 forensic metadata (TRD §11.1): pre-total, delta, expected, actual.
    const hcmRow = rows.find((a) => a.action === 'hcm.decrement.ambiguous');
    expect(hcmRow?.metadata).toMatchObject({
      reason: 'hcm_ambiguous',
      delta: -3,
      expected_pre_total: 10,
      expected: 7,
      actual: 8,
    });

    // REQ-SYNC-04: an ambiguous (F-04) failure enqueues a targeted point recon,
    // not a full batch run, and never schedules a post-commit drift check.
    expect(enqueued).toEqual([
      expect.objectContaining({
        employeeId: 'emp_001',
        locationId: 'loc_001',
        reason: 'hcm_ambiguous',
      }),
    ]);
    // The saga's correlationId is threaded through for point-recon traceability.
    expect(enqueued[0]?.correlationId).toEqual(expect.any(String));
    expect(driftScheduled).toEqual([]);
  });

  it('leaves the request APPROVING when the post-HCM commit exhausts OCC retries (R-04, no sweep yet)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: ({ expectedPreTotal, delta }) =>
        Promise.resolve({ newTotalDays: expectedPreTotal + delta, correlationId: 'hcm_op_1' }),
    };
    const saga = buildSaga(hcm);
    // Force the commit phase to always lose the version race.
    balanceRepo.casCommit = () => Promise.reject(new OccConflictError('balances', 'bal_001'));

    const res = await saga.execute('req_001', manager);

    expect(res.status).toBe('APPROVING');
    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.totalDays).toBe(10); // not committed
    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('lifecycle.commit_deferred');
  });

  it('returns 403 (not 404) when a manager approves a nonexistent request — no enumeration (REQ-DEF-10)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: () => Promise.reject(new Error('should not be called')),
    };
    await expect(buildSaga(hcm).execute('req_ghost', manager)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it('forbids a manager approving a non-report (REQ-LIFE-15)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: () => Promise.reject(new Error('should not be called')),
    };
    const stranger: Principal = { sub: 'mgr_999', roles: ['MANAGER'] };

    await expect(buildSaga(hcm).execute('req_001', stranger)).rejects.toMatchObject({
      httpStatus: 403,
    });
    const req = await dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: 'req_001' });
    expect(req.status).toBe('SUBMITTED');
  });

  it('fast-fails 503 leaving the request SUBMITTED when the breaker is OPEN at entry (REQ-SYNC-06, REQ-DEF-07)', async () => {
    let called = false;
    const hcm: HcmAdjuster = {
      adjustBalance: () => {
        called = true;
        return Promise.reject(new Error('HCM must not be contacted while OPEN'));
      },
    };
    const breaker = closedBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure(); // trip to OPEN

    await expect(buildSaga(hcm, breaker).execute('req_001', manager)).rejects.toMatchObject({
      httpStatus: 503,
      typeUri: '/errors/hcm-unavailable',
    });

    expect(called).toBe(false); // breaker spared HCM
    const req = await dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: 'req_001' });
    expect(req.status).toBe('SUBMITTED'); // never entered APPROVING
    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('hcm.breaker.fast_failed');
  });
});

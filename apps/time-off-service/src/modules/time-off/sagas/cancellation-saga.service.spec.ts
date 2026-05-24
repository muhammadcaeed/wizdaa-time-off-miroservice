import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../../test/support/db';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { OccConflictError } from '../../../common/persistence/occ-conflict.error';
import { AuditLog, Balance, Employee, TimeOffRequest } from '../../../database/entities';
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
import { CancellationSagaService } from './cancellation-saga.service';

/**
 * @req REQ-LIFE-09
 * @req REQ-LIFE-10
 * @req REQ-LIFE-11
 * @req REQ-SYNC-04a
 * @req REQ-SYNC-06
 */
describe('CancellationSagaService (reverse saga T-09/10/11)', () => {
  let dataSource: DataSource;
  let balanceRepo: BalanceRepository;
  let requestRepo: RequestRepository;

  const owner: Principal = { sub: 'emp_001', roles: ['EMPLOYEE'] };

  /** Captures point-recon enqueues so the F-04 wiring can be asserted (REQ-SYNC-04). */
  let enqueued: PointReconciliationJob[];
  /** Captures post-commit drift schedules so the increment wiring can be asserted (REQ-SYNC-04a). */
  let driftScheduled: { op: string; committedTotal: number }[];

  function buildSaga(
    hcm: HcmAdjuster,
    breaker: CircuitBreaker = closedBreaker(),
  ): CancellationSagaService {
    const queue: PointReconciliationQueue = {
      enqueue: (job) => {
        enqueued.push(job);
      },
    };
    const drift = {
      scheduleDriftCheck: (
        _employeeId: string,
        _locationId: string,
        op: 'decrement' | 'increment',
        committedTotal: number,
      ) => {
        driftScheduled.push({ op, committedTotal });
      },
    } as unknown as DriftDetectionService;
    return new CancellationSagaService(
      dataSource,
      balanceRepo,
      requestRepo,
      new AuditService(new AuditRepository()),
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
    // Post-approval state: T-03 already decremented total (10 -> 7) and cleared
    // the reservation (reserved = 0). CANCELLING holds NO reservation.
    await dataSource.getRepository(Balance).insert({
      id: 'bal_001',
      employeeId: 'emp_001',
      locationId: 'loc_001',
      totalDays: 7,
      reservedDays: 0,
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
        status: 'APPROVED',
        submittedAt: new Date(),
      },
      dataSource.manager,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('begins CANCELLING and calls HCM with +days and the :increment key (T-09)', async () => {
    let captured: { delta: number; idempotencyKey: string } | undefined;
    const hcm: HcmAdjuster = {
      adjustBalance: ({ delta, idempotencyKey, expectedPreTotal }) => {
        captured = { delta, idempotencyKey };
        return Promise.resolve({
          newTotalDays: expectedPreTotal + delta,
          correlationId: 'hcm_op_1',
        });
      },
    };

    await buildSaga(hcm).execute('req_001', owner);

    expect(captured).toEqual({ delta: 3, idempotencyKey: 'req_001:increment' });
    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('request.cancelling');
  });

  it('commits CANCELLED, increments total, leaves reserved unchanged, persists correlation id (T-10)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: ({ expectedPreTotal, delta }) =>
        Promise.resolve({ newTotalDays: expectedPreTotal + delta, correlationId: 'hcm_op_1' }),
    };

    const res = await buildSaga(hcm).execute('req_001', owner);

    expect(res.status).toBe('CANCELLED');
    expect(res.hcm_correlation_id).toBe('hcm_op_1');

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.totalDays).toBe(10); // 7 + 3 restored
    expect(balance.reservedDays).toBe(0); // CANCELLING held none — unchanged

    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('request.cancelled');
    expect(actions).toContain('hcm.increment.confirmed');

    // REQ-SYNC-04a: success schedules an increment-direction post-commit drift check.
    expect(driftScheduled).toEqual([{ op: 'increment', committedTotal: 10 }]);
  });

  it('fails to CANCELLATION_FAILED on an ambiguous response, releasing NOTHING (T-11, F-04, ADR-012)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: () => Promise.reject(new HcmArithmeticMismatchError('mismatch', 10, 9)),
    };

    const res = await buildSaga(hcm).execute('req_001', owner);

    expect(res.status).toBe('CANCELLATION_FAILED');
    expect(res.failure_reason).toBe('hcm_ambiguous');

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    // The copy-paste hazard from ADR-012: a stray casRelease would corrupt one of
    // these. CANCELLING holds no reservation, so BOTH must be untouched.
    expect(balance.totalDays).toBe(7); // unchanged
    expect(balance.reservedDays).toBe(0); // unchanged — NOT released

    const rows = await dataSource.getRepository(AuditLog).find();
    const actions = rows.map((a) => a.action);
    expect(actions).toContain('request.cancellation_failed');
    expect(actions).toContain('hcm.increment.ambiguous');

    // REQ-SYNC-04: ambiguous (F-04) enqueues a targeted point recon, no drift check.
    expect(enqueued).toEqual([
      expect.objectContaining({
        employeeId: 'emp_001',
        locationId: 'loc_001',
        reason: 'hcm_ambiguous',
      }),
    ]);
    expect(driftScheduled).toEqual([]);
  });

  it('leaves the request CANCELLING when the post-HCM commit exhausts OCC retries (R-04, no sweep yet)', async () => {
    const hcm: HcmAdjuster = {
      adjustBalance: ({ expectedPreTotal, delta }) =>
        Promise.resolve({ newTotalDays: expectedPreTotal + delta, correlationId: 'hcm_op_1' }),
    };
    const saga = buildSaga(hcm);
    balanceRepo.casCommit = () => Promise.reject(new OccConflictError('balances', 'bal_001'));

    const res = await saga.execute('req_001', owner);

    expect(res.status).toBe('CANCELLING');
    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.totalDays).toBe(7); // not committed
    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('lifecycle.commit_deferred');
  });

  it('fast-fails 503 leaving the request APPROVED when the breaker is OPEN at entry (REQ-SYNC-06)', async () => {
    let called = false;
    const hcm: HcmAdjuster = {
      adjustBalance: () => {
        called = true;
        return Promise.reject(new Error('HCM must not be contacted while OPEN'));
      },
    };
    const breaker = closedBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure();

    await expect(buildSaga(hcm, breaker).execute('req_001', owner)).rejects.toMatchObject({
      httpStatus: 503,
      typeUri: '/errors/hcm-unavailable',
    });

    expect(called).toBe(false);
    const req = await dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: 'req_001' });
    expect(req.status).toBe('APPROVED'); // never entered CANCELLING
    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('hcm.breaker.fast_failed');
  });
});

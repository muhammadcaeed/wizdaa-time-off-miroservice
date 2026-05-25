import { DataSource } from 'typeorm';
import { AuditRepository } from '../../apps/time-off-service/src/common/audit/audit.repository';
import { AuditService } from '../../apps/time-off-service/src/common/audit/audit.service';
import { DomainError } from '../../apps/time-off-service/src/common/errors/domain-error';
import { Balance, Employee, Location, TimeOffRequest } from '../../apps/time-off-service/src/database/entities';
import { AuthorizationService } from '../../apps/time-off-service/src/modules/auth/authorization.service';
import { EmployeeRepository } from '../../apps/time-off-service/src/modules/auth/employee.repository';
import type { Principal } from '../../apps/time-off-service/src/modules/auth/principal';
import { BalanceRepository } from '../../apps/time-off-service/src/modules/balances/balance.repository';
import { CircuitBreaker } from '../../apps/time-off-service/src/modules/hcm-sync/circuit-breaker';
import type { HcmAdjuster } from '../../apps/time-off-service/src/modules/hcm-sync/hcm-adjuster';
import type { DriftDetectionService } from '../../apps/time-off-service/src/modules/reconciliation/drift-detection.service';
import type { PointReconciliationQueue } from '../../apps/time-off-service/src/modules/reconciliation/point-reconciliation-queue';
import { RequestRepository } from '../../apps/time-off-service/src/modules/time-off/request.repository';
import { RequestService } from '../../apps/time-off-service/src/modules/time-off/request.service';
import type { IdempotencyService } from '../../apps/time-off-service/src/modules/time-off/idempotency.service';
import { ApprovalSagaService } from '../../apps/time-off-service/src/modules/time-off/sagas/approval-saga.service';
import { CancellationSagaService } from '../../apps/time-off-service/src/modules/time-off/sagas/cancellation-saga.service';
import { createTestDataSource } from './db';

/** No-op idempotency stub for property tests that don't exercise idempotency. */
const noopIdempotency = {
  check: () => Promise.resolve(null),
  record: () => Promise.resolve(undefined),
  cleanup: () => Promise.resolve(undefined),
} as unknown as IdempotencyService;

/** No-op point queue: the property driver never exercises drift enqueue paths. */
const noopQueue: PointReconciliationQueue = { enqueue: () => undefined };

/**
 * No-op drift detector: the property driver's HCM stub always confirms, so no
 * drift fires. The cast erases the full {@link DriftDetectionService} surface —
 * if a new method becomes load-bearing on this path, the property suite will
 * throw at runtime, not compile time. Acceptable for this single-method stub.
 */
const noopDrift = { scheduleDriftCheck: () => undefined } as unknown as DriftDetectionService;

/** An always-confirming HCM stub: returns exactly the expected post-total. */
const confirmingHcm: HcmAdjuster = {
  adjustBalance: ({ expectedPreTotal, delta }) =>
    Promise.resolve({ newTotalDays: expectedPreTotal + delta, correlationId: 'hcm_ok' }),
};

/** A breaker held CLOSED; the property driver never exercises HCM failure. */
const closedBreaker = (): CircuitBreaker =>
  new CircuitBreaker(
    { failureThreshold: 5, failureRate: 0.5, cooldownMs: 30_000, probeDeadlineMs: 10_000 },
    Date.now,
    { info: () => undefined } as never,
  );

export type Op =
  | { kind: 'submit'; emp: number; days: number }
  | { kind: 'approve'; pick: number }
  | { kind: 'reject'; pick: number };

const MANAGER: Principal = { sub: 'mgr_0', roles: ['MANAGER'] };

/**
 * In-process driver that exercises the real services (submit, approve saga,
 * reject) against a fresh SQLite schema — the same code paths the controllers
 * call, without HTTP. Used by the property suite to apply random operation
 * sequences and assert invariants (test-strategy.md §5).
 */
export class ApplicationDriver {
  private constructor(
    readonly dataSource: DataSource,
    private readonly requestService: RequestService,
    private readonly approvalSaga: ApprovalSagaService,
    readonly employeeCount: number,
    readonly locationId: string,
  ) {}

  private readonly requestIds: string[] = [];

  static async create(employeeCount = 5): Promise<ApplicationDriver> {
    const dataSource = await createTestDataSource();
    const balanceRepo = new BalanceRepository(dataSource);
    const requestRepo = new RequestRepository(dataSource);
    const audit = new AuditService(new AuditRepository());
    const authz = new AuthorizationService(new EmployeeRepository(dataSource));
    const cancellationSaga = new CancellationSagaService(
      dataSource,
      balanceRepo,
      requestRepo,
      audit,
      confirmingHcm,
      closedBreaker(),
      noopQueue,
      noopDrift,
      noopIdempotency,
    );
    const requestService = new RequestService(
      dataSource,
      balanceRepo,
      requestRepo,
      audit,
      authz,
      cancellationSaga,
      noopIdempotency,
    );
    const saga = new ApprovalSagaService(
      dataSource,
      balanceRepo,
      requestRepo,
      audit,
      authz,
      confirmingHcm,
      closedBreaker(),
      noopQueue,
      noopDrift,
      noopIdempotency,
    );

    await dataSource.getRepository(Location).insert({ id: 'loc_0', name: 'HQ', countryCode: 'US' });
    await dataSource.getRepository(Employee).insert({
      id: 'mgr_0',
      email: 'mgr@x.io',
      firstName: 'M',
      lastName: 'G',
      locationId: 'loc_0',
      managerId: null,
    });
    for (let i = 0; i < employeeCount; i++) {
      await dataSource.getRepository(Employee).insert({
        id: `emp_${i}`,
        email: `e${i}@x.io`,
        firstName: 'E',
        lastName: `${i}`,
        locationId: 'loc_0',
        managerId: 'mgr_0',
      });
      await dataSource.getRepository(Balance).insert({
        id: `bal_${i}`,
        employeeId: `emp_${i}`,
        locationId: 'loc_0',
        totalDays: 20,
        reservedDays: 0,
        version: 0,
      });
    }

    return new ApplicationDriver(dataSource, requestService, saga, employeeCount, 'loc_0');
  }

  async apply(op: Op): Promise<void> {
    try {
      if (op.kind === 'submit') {
        const emp = op.emp % this.employeeCount;
        const res = await this.requestService.submit(
          { sub: `emp_${emp}`, roles: ['EMPLOYEE'] },
          {
            location_id: this.locationId,
            start_date: '2026-07-01',
            end_date: '2026-07-05',
            days_requested: op.days,
          },
        );
        this.requestIds.push(res.id);
      } else if (op.kind === 'approve' && this.requestIds.length > 0) {
        await this.approvalSaga.execute(this.requestIds[op.pick % this.requestIds.length], MANAGER);
      } else if (op.kind === 'reject' && this.requestIds.length > 0) {
        await this.requestService.reject(MANAGER, this.requestIds[op.pick % this.requestIds.length]);
      }
    } catch (err) {
      // Domain errors are legitimate outcomes of a random sequence (insufficient
      // balance, wrong-state transition). Anything else is a real bug.
      if (!(err instanceof DomainError)) {
        throw err;
      }
    }
  }

  /** Asserts INV-01, INV-02, INV-03 hold for every balance (TRD §4.2). */
  async assertInvariants(): Promise<void> {
    const balances = await this.dataSource.getRepository(Balance).find();
    const requestRepo = new RequestRepository(this.dataSource);
    for (const b of balances) {
      if (b.reservedDays < 0) {
        throw new Error(`INV-01 violated: reserved ${b.reservedDays} < 0 for ${b.employeeId}`);
      }
      if (b.totalDays - b.reservedDays < 0) {
        throw new Error(
          `INV-02 violated: total ${b.totalDays} - reserved ${b.reservedDays} < 0 for ${b.employeeId}`,
        );
      }
      const expected = await requestRepo.sumReservedDays(b.employeeId, b.locationId);
      if (b.reservedDays !== expected) {
        throw new Error(
          `INV-03 violated: reserved ${b.reservedDays} != sum ${expected} for ${b.employeeId}`,
        );
      }
    }
  }

  async destroy(): Promise<void> {
    await this.dataSource.destroy();
  }
}

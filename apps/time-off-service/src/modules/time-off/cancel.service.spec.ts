import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AuditService } from '../../common/audit/audit.service';
import { ForbiddenError } from '../../common/errors/forbidden.error';
import { InvalidTransitionError } from '../../common/errors/invalid-transition.error';
import { AuditLog, Balance, Employee } from '../../database/entities';
import type { RequestStatus } from '../../database/entities';
import { AuthorizationService } from '../auth/authorization.service';
import { EmployeeRepository } from '../auth/employee.repository';
import type { Principal } from '../auth/principal';
import { BalanceRepository } from '../balances/balance.repository';
import type { HcmAdjuster } from '../hcm-sync/hcm-adjuster';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import { CancellationSagaService } from './sagas/cancellation-saga.service';
import type { IdempotencyService } from './idempotency.service';

/** No-op idempotency stub for unit tests that don't exercise idempotency. */
const noopIdempotency = {
  check: () => Promise.resolve(null),
  record: () => Promise.resolve(undefined),
  cleanup: () => Promise.resolve(undefined),
} as unknown as IdempotencyService;

/**
 * @req REQ-LIFE-08
 * @req REQ-LIFE-09
 * @req REQ-LIFE-13
 * @req REQ-LIFE-14
 * @req REQ-DEF-10
 */
describe('RequestService.cancel (router T-06/08/09, ADR-012)', () => {
  let dataSource: DataSource;
  let service: RequestService;
  /** Records HCM calls so the no-HCM paths (T-06, T-08) can assert zero contact. */
  let hcmCalls: number;

  const owner: Principal = { sub: 'emp_001', roles: ['EMPLOYEE'] };
  const admin: Principal = { sub: 'adm_001', roles: ['ADMIN'] };
  const stranger: Principal = { sub: 'emp_999', roles: ['EMPLOYEE'] };
  const reportManager: Principal = { sub: 'mgr_001', roles: ['MANAGER'] };

  /** A future date so the APPROVED gate passes; "today" is 2026-05-24 in this env. */
  const FUTURE = '2026-07-01';
  /** A past date so the APPROVED gate rejects with 409 (TRD §5.3). */
  const PAST = '2020-01-01';

  function buildService(): RequestService {
    const hcm: HcmAdjuster = {
      adjustBalance: ({ expectedPreTotal, delta }) => {
        hcmCalls += 1;
        return Promise.resolve({ newTotalDays: expectedPreTotal + delta, correlationId: 'hcm_c' });
      },
    };
    const balanceRepo = new BalanceRepository(dataSource);
    const requestRepo = new RequestRepository(dataSource);
    const audit = new AuditService(new AuditRepository());
    const authz = new AuthorizationService(new EmployeeRepository(dataSource));
    const saga = {
      execute: (requestId: string) =>
        // Minimal stand-in for the real saga: the router-delegation contract is
        // "call execute and return its result". The saga has its own spec.
        (async () => {
          await hcm.adjustBalance({
            employeeId: 'emp_001',
            locationId: 'loc_001',
            delta: 3,
            idempotencyKey: `${requestId}:increment`,
            expectedPreTotal: 7,
            sourceReference: `request:${requestId}`,
          });
          return {
            id: requestId,
            employee_id: 'emp_001',
            location_id: 'loc_001',
            start_date: FUTURE,
            end_date: FUTURE,
            days_requested: 3,
            status: 'CANCELLING',
            submitted_at: new Date().toISOString(),
            decided_at: null,
            hcm_correlation_id: null,
            failure_reason: null,
          };
        })(),
    } as unknown as CancellationSagaService;
    return new RequestService(
      dataSource,
      balanceRepo,
      requestRepo,
      audit,
      authz,
      saga,
      noopIdempotency,
    );
  }

  async function seedRequest(id: string, status: RequestStatus, startDate: string): Promise<void> {
    await new RequestRepository(dataSource).insert(
      {
        id,
        employeeId: 'emp_001',
        locationId: 'loc_001',
        startDate,
        endDate: startDate,
        daysRequested: 3,
        status,
        submittedAt: new Date(),
      },
      dataSource.manager,
    );
  }

  beforeEach(async () => {
    hcmCalls = 0;
    dataSource = await createTestDataSource();
    service = buildService();
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
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('T-08: owner cancelling a SUBMITTED request releases the reservation in one tx (sync 200)', async () => {
    await seedRequest('req_001', 'SUBMITTED', FUTURE);

    const outcome = await service.cancel(owner, 'req_001');

    expect(outcome.accepted).toBe(false); // sync terminal -> 200
    expect(outcome.request.status).toBe('CANCELLED');
    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.reservedDays).toBe(0);
    expect(hcmCalls).toBe(0);

    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('request.cancelled');
  });

  it('T-06: cancelling an APPROVAL_FAILED request discards it — no HCM, no balance change, audit request.discarded', async () => {
    await seedRequest('req_001', 'APPROVAL_FAILED', FUTURE);

    const outcome = await service.cancel(owner, 'req_001');

    expect(outcome.accepted).toBe(false);
    expect(outcome.request.status).toBe('CANCELLED');
    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.reservedDays).toBe(3); // untouched
    expect(balance.totalDays).toBe(10); // untouched
    expect(hcmCalls).toBe(0);

    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('request.discarded'); // NOT request.cancelled (ADR-012)
    expect(actions).not.toContain('request.cancelled');
  });

  it('T-09: owner cancelling a future-dated APPROVED request delegates to the saga (async 202)', async () => {
    await seedRequest('req_001', 'APPROVED', FUTURE);

    const outcome = await service.cancel(owner, 'req_001');

    expect(outcome.accepted).toBe(true); // saga path -> 202
    expect(hcmCalls).toBe(1);
  });

  it('rejects a past-dated APPROVED cancel with 409 (TRD §5.3 gating)', async () => {
    await seedRequest('req_001', 'APPROVED', PAST);

    await expect(service.cancel(owner, 'req_001')).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(hcmCalls).toBe(0);
  });

  it('rejects a same-day (today) APPROVED cancel with 409 — equal-to-today is past', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await seedRequest('req_001', 'APPROVED', today);

    await expect(service.cancel(owner, 'req_001')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('rejects a cancel during APPROVING with 409 (R-05, REQ-LIFE-14)', async () => {
    await seedRequest('req_001', 'APPROVING', FUTURE);
    await expect(service.cancel(owner, 'req_001')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('rejects a cancel during CANCELLING with 409 (R-05, REQ-LIFE-14)', async () => {
    await seedRequest('req_001', 'CANCELLING', FUTURE);
    await expect(service.cancel(owner, 'req_001')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('forbids a non-owner non-admin (403), even a manager — managers do not get cancel', async () => {
    await seedRequest('req_001', 'SUBMITTED', FUTURE);
    await expect(service.cancel(stranger, 'req_001')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.cancel(reportManager, 'req_001')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets an admin cancel on behalf of an employee', async () => {
    await seedRequest('req_001', 'SUBMITTED', FUTURE);
    const outcome = await service.cancel(admin, 'req_001');
    expect(outcome.request.status).toBe('CANCELLED');
  });

  it('returns 403 (not 404) when a non-admin cancels a nonexistent request (REQ-DEF-10)', async () => {
    await expect(service.cancel(owner, 'req_ghost')).rejects.toMatchObject({ httpStatus: 403 });
  });
});

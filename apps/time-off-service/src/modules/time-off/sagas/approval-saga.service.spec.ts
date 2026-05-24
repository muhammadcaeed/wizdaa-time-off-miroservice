import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../../test/support/db';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { OccConflictError } from '../../../common/persistence/occ-conflict.error';
import { AuditLog, Balance, Employee, TimeOffRequest } from '../../../database/entities';
import { AuthorizationService } from '../../auth/authorization.service';
import { EmployeeRepository } from '../../auth/employee.repository';
import type { Principal } from '../../auth/principal';
import type { HcmAdjuster } from '../../hcm-sync/hcm-adjuster';
import { HcmArithmeticMismatchError } from '../../hcm-sync/hcm.errors';
import { BalanceRepository } from '../../balances/balance.repository';
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

  function buildSaga(hcm: HcmAdjuster): ApprovalSagaService {
    return new ApprovalSagaService(
      dataSource,
      balanceRepo,
      requestRepo,
      new AuditService(new AuditRepository()),
      new AuthorizationService(new EmployeeRepository(dataSource)),
      hcm,
    );
  }

  beforeEach(async () => {
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
});

import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { OccConflictError } from '../../common/persistence/occ-conflict.error';
import { Balance } from '../../database/entities';
import { BalanceRepository } from './balance.repository';

/**
 * @req REQ-DEF-08
 * @req REQ-LIFE-01
 * @req REQ-LIFE-04
 */
describe('BalanceRepository (version-check CAS)', () => {
  let dataSource: DataSource;
  let repo: BalanceRepository;

  const BAL_ID = 'bal_001';
  const EMP_ID = 'emp_001';
  const LOC_ID = 'loc_001';

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    repo = new BalanceRepository(dataSource);
    await dataSource.getRepository(Balance).insert({
      id: BAL_ID,
      employeeId: EMP_ID,
      locationId: LOC_ID,
      totalDays: 20,
      reservedDays: 0,
      version: 0,
    });
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('finds a balance by (employee_id, location_id)', async () => {
    const found = await repo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(found?.id).toBe(BAL_ID);
    expect(found?.totalDays).toBe(20);
  });

  it('casReserve increments reserved_days and bumps version when the version matches', async () => {
    await repo.casReserve(BAL_ID, 0, 5, dataSource.manager);

    const after = await repo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.reservedDays).toBe(5);
    expect(after?.version).toBe(1);
    expect(after?.totalDays).toBe(20);
  });

  it('casReserve throws OccConflictError when the observed version is stale', async () => {
    await repo.casReserve(BAL_ID, 0, 5, dataSource.manager); // version is now 1

    await expect(repo.casReserve(BAL_ID, 0, 3, dataSource.manager)).rejects.toBeInstanceOf(
      OccConflictError,
    );
  });

  it('casCommit applies total and reserved deltas, bumps version, persists correlation id', async () => {
    await repo.casReserve(BAL_ID, 0, 5, dataSource.manager); // version 1, reserved 5

    await repo.casCommit(BAL_ID, 1, -5, -5, 'hcm_op_456', dataSource.manager);

    const after = await repo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(15);
    expect(after?.reservedDays).toBe(0);
    expect(after?.version).toBe(2);
    expect(after?.lastHcmCorrelationId).toBe('hcm_op_456');
  });

  it('casRelease decrements reserved_days and bumps version', async () => {
    await repo.casReserve(BAL_ID, 0, 5, dataSource.manager); // version 1, reserved 5

    await repo.casRelease(BAL_ID, 1, -5, dataSource.manager);

    const after = await repo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.reservedDays).toBe(0);
    expect(after?.version).toBe(2);
  });

  it('casReconcile sets absolute total/reserved, bumps version, stamps last_hcm_sync_at', async () => {
    await repo.casReconcile(BAL_ID, 0, 18, 2, dataSource.manager);

    const after = await repo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(18);
    expect(after?.reservedDays).toBe(2);
    expect(after?.version).toBe(1);
    // null in the seed -> non-null proves the literal-value set actually wrote.
    expect(after?.lastHcmSyncAt).not.toBeNull();
  });

  it('casReconcile throws OccConflictError when the observed version is stale', async () => {
    await repo.casReconcile(BAL_ID, 0, 18, 2, dataSource.manager); // version is now 1

    await expect(repo.casReconcile(BAL_ID, 0, 19, 1, dataSource.manager)).rejects.toBeInstanceOf(
      OccConflictError,
    );
  });

  it('casReconcileTotal sets absolute total only (TRD §9.3), leaves reserved untouched, bumps version', async () => {
    await repo.casReserve(BAL_ID, 0, 4, dataSource.manager); // version 1, reserved 4

    await repo.casReconcileTotal(BAL_ID, 1, 25, dataSource.manager);

    const after = await repo.findByEmployeeAndLocation(EMP_ID, LOC_ID);
    expect(after?.totalDays).toBe(25);
    expect(after?.reservedDays).toBe(4); // §9.3 does NOT touch reserved
    expect(after?.version).toBe(2);
    expect(after?.lastHcmSyncAt).not.toBeNull();
  });

  it('casReconcileTotal throws OccConflictError when the observed version is stale', async () => {
    await repo.casReconcileTotal(BAL_ID, 0, 18, dataSource.manager); // version is now 1

    await expect(repo.casReconcileTotal(BAL_ID, 0, 19, dataSource.manager)).rejects.toBeInstanceOf(
      OccConflictError,
    );
  });
});

import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { InvalidTransitionError } from '../../common/errors/invalid-transition.error';
import { RequestRepository } from './request.repository';

/**
 * @req REQ-LIFE-01
 * @req REQ-LIFE-03
 * @req REQ-LIFE-16
 */
describe('RequestRepository (status-predicate CAS)', () => {
  let dataSource: DataSource;
  let repo: RequestRepository;

  const REQ_ID = 'req_001';

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    repo = new RequestRepository(dataSource);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function seedSubmitted(): Promise<void> {
    await repo.insert(
      {
        id: REQ_ID,
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
  }

  it('inserts a request and reads it back by id', async () => {
    await seedSubmitted();
    const found = await repo.findById(REQ_ID);
    expect(found?.status).toBe('SUBMITTED');
    expect(found?.daysRequested).toBe(3);
  });

  it('casStatus transitions SUBMITTED -> APPROVING when the predicate matches', async () => {
    await seedSubmitted();
    await repo.casStatus(
      REQ_ID,
      'SUBMITTED',
      'APPROVING',
      { decidedBy: 'mgr_001' },
      dataSource.manager,
    );

    const found = await repo.findById(REQ_ID);
    expect(found?.status).toBe('APPROVING');
    expect(found?.decidedBy).toBe('mgr_001');
  });

  it('casStatus throws InvalidTransitionError when the current status does not match', async () => {
    await seedSubmitted();
    await repo.casStatus(REQ_ID, 'SUBMITTED', 'APPROVING', {}, dataSource.manager);

    await expect(
      repo.casStatus(REQ_ID, 'SUBMITTED', 'APPROVING', {}, dataSource.manager),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('casStatus applies patch fields on the failure transition', async () => {
    await seedSubmitted();
    await repo.casStatus(REQ_ID, 'SUBMITTED', 'APPROVING', {}, dataSource.manager);
    await repo.casStatus(
      REQ_ID,
      'APPROVING',
      'APPROVAL_FAILED',
      { failureReason: 'hcm_ambiguous' },
      dataSource.manager,
    );

    const found = await repo.findById(REQ_ID);
    expect(found?.status).toBe('APPROVAL_FAILED');
    expect(found?.failureReason).toBe('hcm_ambiguous');
  });

  it('sums reserved days across SUBMITTED, APPROVING and CANCELLING for INV-03 checks', async () => {
    await seedSubmitted(); // 3 days, SUBMITTED
    await repo.insert(
      {
        id: 'req_002',
        employeeId: 'emp_001',
        locationId: 'loc_001',
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        daysRequested: 2,
        status: 'APPROVED', // committed, not reserved
        submittedAt: new Date(),
      },
      dataSource.manager,
    );

    const reserved = await repo.sumReservedDays('emp_001', 'loc_001');
    expect(reserved).toBe(3);
  });
});

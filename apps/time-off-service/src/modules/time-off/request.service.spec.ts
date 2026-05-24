import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AuditService } from '../../common/audit/audit.service';
import { InsufficientBalanceError } from '../../common/errors/insufficient-balance.error';
import { AuditLog, Balance, TimeOffRequest } from '../../database/entities';
import { AuthorizationService } from '../auth/authorization.service';
import { EmployeeRepository } from '../auth/employee.repository';
import { BalanceRepository } from '../balances/balance.repository';
import type { Principal } from '../auth/principal';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import type { CancellationSagaService } from './sagas/cancellation-saga.service';
import type { SubmitRequestDto } from './dto/submit-request.dto';

/**
 * @req REQ-LIFE-01
 * @req REQ-LIFE-02
 * @req REQ-DEF-05
 * @req INV-03
 */
describe('RequestService.submit (T-01 reservation)', () => {
  let dataSource: DataSource;
  let service: RequestService;

  const employee: Principal = { sub: 'emp_001', roles: ['EMPLOYEE'] };
  const dto: SubmitRequestDto = {
    location_id: 'loc_001',
    start_date: '2026-07-01',
    end_date: '2026-07-03',
    days_requested: 3,
  };

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    service = new RequestService(
      dataSource,
      new BalanceRepository(dataSource),
      new RequestRepository(dataSource),
      new AuditService(new AuditRepository()),
      new AuthorizationService(new EmployeeRepository(dataSource)),
      // submit never routes to the cancellation saga; a never-called stub keeps
      // this spec focused on T-01.
      undefined as unknown as CancellationSagaService,
    );
    await dataSource.getRepository(Balance).insert({
      id: 'bal_001',
      employeeId: 'emp_001',
      locationId: 'loc_001',
      totalDays: 10,
      reservedDays: 0,
      version: 0,
    });
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('creates a SUBMITTED request and reserves the days in one transaction', async () => {
    const res = await service.submit(employee, dto);

    expect(res.status).toBe('SUBMITTED');
    expect(res.days_requested).toBe(3);

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.reservedDays).toBe(3);
    expect(balance.version).toBe(1);

    const stored = await dataSource.getRepository(TimeOffRequest).findOneByOrFail({ id: res.id });
    expect(stored.employeeId).toBe('emp_001');
  });

  it('writes a request.submitted audit row in the same transaction', async () => {
    const res = await service.submit(employee, dto);

    const audits = await dataSource.getRepository(AuditLog).find();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('request.submitted');
    expect(audits[0].entityId).toBe(res.id);
  });

  it('rejects a request exceeding available days with 409 and no state change', async () => {
    await expect(service.submit(employee, { ...dto, days_requested: 11 })).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.reservedDays).toBe(0);
    expect(balance.version).toBe(0);
    expect(await dataSource.getRepository(TimeOffRequest).count()).toBe(0);
    expect(await dataSource.getRepository(AuditLog).count()).toBe(0);
  });

  it('keeps reserved_days equal to the sum of reserving requests (INV-03)', async () => {
    await service.submit(employee, dto); // 3
    await service.submit(employee, { ...dto, days_requested: 2 }); // 2

    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    const repo = new RequestRepository(dataSource);
    expect(balance.reservedDays).toBe(await repo.sumReservedDays('emp_001', 'loc_001'));
    expect(balance.reservedDays).toBe(5);
  });
});

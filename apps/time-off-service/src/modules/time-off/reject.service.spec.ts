import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AuditService } from '../../common/audit/audit.service';
import { InvalidTransitionError } from '../../common/errors/invalid-transition.error';
import { AuditLog, Balance, Employee } from '../../database/entities';
import { AuthorizationService } from '../auth/authorization.service';
import { EmployeeRepository } from '../auth/employee.repository';
import type { Principal } from '../auth/principal';
import { BalanceRepository } from '../balances/balance.repository';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import type { CancellationSagaService } from './sagas/cancellation-saga.service';

/**
 * @req REQ-LIFE-07
 * @req INV-03
 */
describe('RequestService.reject (T-07)', () => {
  let dataSource: DataSource;
  let service: RequestService;

  const manager: Principal = { sub: 'mgr_001', roles: ['MANAGER'] };

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    service = new RequestService(
      dataSource,
      new BalanceRepository(dataSource),
      new RequestRepository(dataSource),
      new AuditService(new AuditRepository()),
      new AuthorizationService(new EmployeeRepository(dataSource)),
      // reject never routes to the cancellation saga; a never-called stub.
      undefined as unknown as CancellationSagaService,
    );
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
    await new RequestRepository(dataSource).insert(
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

  it('transitions SUBMITTED -> REJECTED and releases the reservation', async () => {
    const res = await service.reject(manager, 'req_001');

    expect(res.status).toBe('REJECTED');
    const balance = await dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_001' });
    expect(balance.reservedDays).toBe(0);

    const actions = (await dataSource.getRepository(AuditLog).find()).map((a) => a.action);
    expect(actions).toContain('request.rejected');
  });

  it('rejects a non-SUBMITTED request with 409', async () => {
    await service.reject(manager, 'req_001');
    await expect(service.reject(manager, 'req_001')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('returns 403 (not 404) when a manager rejects a nonexistent request — no enumeration (REQ-DEF-10)', async () => {
    await expect(service.reject(manager, 'req_ghost')).rejects.toMatchObject({ httpStatus: 403 });
  });
});

import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { ForbiddenError } from '../../common/errors/forbidden.error';
import { Employee } from '../../database/entities';
import { EmployeeRepository } from './employee.repository';
import { AuthorizationService } from './authorization.service';
import type { Principal } from './principal';

/**
 * @req REQ-BAL-01
 * @req REQ-BAL-02
 * @req REQ-BAL-03
 * @req REQ-LIFE-15
 * @req REQ-DEF-10
 */
describe('AuthorizationService (RBAC, 403 hides existence)', () => {
  let dataSource: DataSource;
  let authz: AuthorizationService;

  const employee: Principal = { sub: 'emp_001', roles: ['EMPLOYEE'] };
  const manager: Principal = { sub: 'mgr_001', roles: ['EMPLOYEE', 'MANAGER'] };
  const admin: Principal = { sub: 'adm_001', roles: ['ADMIN'] };

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    authz = new AuthorizationService(new EmployeeRepository(dataSource));
    const repo = dataSource.getRepository(Employee);
    await repo.insert([
      {
        id: 'emp_001',
        email: 'e1@x.io',
        firstName: 'E',
        lastName: 'One',
        locationId: 'loc_001',
        managerId: 'mgr_001',
      },
      {
        id: 'emp_002',
        email: 'e2@x.io',
        firstName: 'E',
        lastName: 'Two',
        locationId: 'loc_001',
        managerId: 'mgr_999',
      },
      {
        id: 'mgr_001',
        email: 'm1@x.io',
        firstName: 'M',
        lastName: 'One',
        locationId: 'loc_001',
        managerId: null,
      },
    ]);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  describe('balance reads', () => {
    it('allows an employee to read their own balance', async () => {
      await expect(authz.assertCanReadBalance(employee, 'emp_001')).resolves.toBeUndefined();
    });

    it('allows a manager to read a direct report', async () => {
      await expect(authz.assertCanReadBalance(manager, 'emp_001')).resolves.toBeUndefined();
    });

    it('allows an admin to read anyone', async () => {
      await expect(authz.assertCanReadBalance(admin, 'emp_002')).resolves.toBeUndefined();
    });

    it('forbids a manager reading a non-report', async () => {
      await expect(authz.assertCanReadBalance(manager, 'emp_002')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('forbids reading a nonexistent employee with the same error (no existence leak)', async () => {
      await expect(authz.assertCanReadBalance(manager, 'emp_ghost')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe('approval', () => {
    it('allows a manager to approve a direct report’s request', async () => {
      await expect(authz.assertCanApprove(manager, 'emp_001')).resolves.toBeUndefined();
    });

    it('forbids a manager approving a non-report', async () => {
      await expect(authz.assertCanApprove(manager, 'emp_002')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('allows an admin to approve anyone', async () => {
      await expect(authz.assertCanApprove(admin, 'emp_002')).resolves.toBeUndefined();
    });
  });

  describe('cancellation (owner or admin only — managers excluded)', () => {
    it('allows the owner to cancel their own request', () => {
      expect(() => authz.assertCanCancel(employee, 'emp_001')).not.toThrow();
    });

    it('allows an admin to cancel anyone’s request', () => {
      expect(() => authz.assertCanCancel(admin, 'emp_002')).not.toThrow();
    });

    it('forbids a manager cancelling a direct report — managers do not get cancel', () => {
      expect(() => authz.assertCanCancel(manager, 'emp_001')).toThrow(ForbiddenError);
    });

    it('forbids a stranger cancelling someone else’s request', () => {
      expect(() => authz.assertCanCancel(employee, 'emp_002')).toThrow(ForbiddenError);
    });
  });
});

import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { AuditLog } from '../../database/entities';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/**
 * @req REQ-DEF-05
 * @req REQ-DEF-06
 * @req INV-05
 */
describe('AuditService (append-only, transaction-bound)', () => {
  let dataSource: DataSource;
  let service: AuditService;

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    service = new AuditService(new AuditRepository());
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('records an audit row with actor, action, and before/after state', async () => {
    await service.record(
      {
        actorId: 'mgr_001',
        actorType: 'MANAGER',
        entityType: 'REQUEST',
        entityId: 'req_001',
        action: 'request.approving',
        beforeState: { status: 'SUBMITTED' },
        afterState: { status: 'APPROVING' },
        correlationId: 'corr_1',
      },
      dataSource.manager,
    );

    const rows = await dataSource.getRepository(AuditLog).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('request.approving');
    expect(rows[0].afterState).toEqual({ status: 'APPROVING' });
    expect(rows[0].timestamp).toBeInstanceOf(Date);
  });

  it('does not persist the audit row when the surrounding transaction rolls back', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await service.record(
          {
            actorType: 'SYSTEM',
            entityType: 'REQUEST',
            entityId: 'req_001',
            action: 'request.approved',
          },
          manager,
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const count = await dataSource.getRepository(AuditLog).count();
    expect(count).toBe(0);
  });

  it('exposes insert only — no update or delete on the audit repository (INV-05)', () => {
    const proto = Object.getPrototypeOf(new AuditRepository()) as object;
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor');
    expect(methods).toEqual(['insert']);
  });
});

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { OccConflictError } from '../../common/persistence/occ-conflict.error';
import { Balance } from '../../database/entities';

/**
 * Data access for {@link Balance} rows. Every mutating method is an optimistic
 * compare-and-swap keyed on the `version` column (TRD §10.2, ADR-005): the
 * UPDATE carries `WHERE id = :id AND version = :expectedVersion` and increments
 * `version`. A zero-row result means a concurrent writer won the race and the
 * method throws {@link OccConflictError} for {@link withOccRetry} to handle.
 *
 * Mutating methods take the active {@link EntityManager} so the write joins the
 * caller's transaction (the audit row shares the same commit boundary, INV-05).
 */
@Injectable()
export class BalanceRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Loads the single balance row for an (employee, location) pair.
   * @returns the balance, or null if none exists for the pair
   */
  async findByEmployeeAndLocation(
    employeeId: string,
    locationId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Balance | null> {
    return manager.getRepository(Balance).findOne({ where: { employeeId, locationId } });
  }

  /** All balance rows for an employee (one per location). */
  async findByEmployeeId(
    employeeId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Balance[]> {
    return manager.getRepository(Balance).find({ where: { employeeId } });
  }

  /**
   * Reserves `delta` days against a balance (T-01). `reserved_days += delta`.
   * @throws OccConflictError when the version predicate matches zero rows
   */
  async casReserve(
    id: string,
    expectedVersion: number,
    delta: number,
    manager: EntityManager,
  ): Promise<void> {
    await this.cas(manager, id, expectedVersion, {
      reservedDays: () => 'reserved_days + :reservedDelta',
      params: { reservedDelta: delta },
    });
  }

  /**
   * Commits an approved decrement (T-03): `total_days += totalDelta`,
   * `reserved_days += reservedDelta` (both negative for an approval), and
   * records the HCM correlation id.
   * @throws OccConflictError when the version predicate matches zero rows
   */
  async casCommit(
    id: string,
    expectedVersion: number,
    totalDelta: number,
    reservedDelta: number,
    correlationId: string,
    manager: EntityManager,
  ): Promise<void> {
    await this.cas(manager, id, expectedVersion, {
      totalDays: () => 'total_days + :totalDelta',
      reservedDays: () => 'reserved_days + :reservedDelta',
      lastHcmCorrelationId: correlationId,
      lastHcmSyncAt: new Date(),
      params: { totalDelta, reservedDelta },
    });
  }

  /**
   * Releases a held reservation (T-04 compensation, T-07, T-08):
   * `reserved_days += reservedDelta` (negative).
   * @throws OccConflictError when the version predicate matches zero rows
   */
  async casRelease(
    id: string,
    expectedVersion: number,
    reservedDelta: number,
    manager: EntityManager,
  ): Promise<void> {
    await this.cas(manager, id, expectedVersion, {
      reservedDays: () => 'reserved_days + :reservedDelta',
      params: { reservedDelta },
    });
  }

  /**
   * Overwrites a balance with absolute HCM-sourced values during reconciliation
   * (TRD §9.3, §9.7): `total_days` and `reserved_days` are set, not adjusted,
   * and `last_hcm_sync_at` is stamped. Version-CAS guards against a concurrent
   * saga write between the read and this overwrite (ADR-005).
   * @param id the balance row id
   * @param expectedVersion version observed at read time; the CAS predicate
   * @param newTotalDays absolute total to persist (HCM is source of truth)
   * @param newReservedDays absolute reserved count to persist
   * @param manager the active transaction's entity manager
   * @returns nothing; the row is updated in place
   * @throws OccConflictError when the version predicate matches zero rows
   */
  async casReconcile(
    id: string,
    expectedVersion: number,
    newTotalDays: number,
    newReservedDays: number,
    manager: EntityManager,
  ): Promise<void> {
    // Literal values (not `() => 'expr'`) so .set() writes absolutes, not deltas.
    await this.cas(manager, id, expectedVersion, {
      totalDays: newTotalDays,
      reservedDays: newReservedDays,
      lastHcmSyncAt: new Date(),
    });
  }

  /**
   * Overwrites ONLY `total_days` with the absolute HCM value during point
   * reconciliation (TRD §9.7), stamping `last_hcm_sync_at`. Unlike
   * {@link casReconcile} (the §9.3 batch path) it deliberately does NOT write
   * `reserved_days`: §9.7 sets the total alone, leaving the locally-owned
   * reservation count untouched. Version-CAS guards against a concurrent saga
   * write between the read and this overwrite (ADR-005).
   * @param id the balance row id
   * @param expectedVersion version observed at read time; the CAS predicate
   * @param newTotalDays absolute total to persist (HCM is source of truth)
   * @param manager the active transaction's entity manager
   * @returns nothing; the row is updated in place
   * @throws OccConflictError when the version predicate matches zero rows
   */
  async casReconcileTotal(
    id: string,
    expectedVersion: number,
    newTotalDays: number,
    manager: EntityManager,
  ): Promise<void> {
    // Literal value (not `() => 'expr'`) so .set() writes the absolute total.
    await this.cas(manager, id, expectedVersion, {
      totalDays: newTotalDays,
      lastHcmSyncAt: new Date(),
    });
  }

  /**
   * Stamps `last_hcm_sync_at = now()` without touching the version or counters
   * (TRD §9.3 no-drift branch). Deliberately carries NO version predicate: a
   * metadata touch must not race a concurrent saga write, and observing equal
   * totals proves there is nothing to reconcile, so there is no CAS to lose.
   * @param id the balance row id
   * @param manager the active transaction's entity manager
   * @returns nothing; the sync timestamp is refreshed in place
   */
  async touchHcmSyncAt(id: string, manager: EntityManager): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Balance)
      .set({ lastHcmSyncAt: new Date() })
      .where('id = :id', { id })
      .execute();
  }

  private async cas(
    manager: EntityManager,
    id: string,
    expectedVersion: number,
    set: Record<string, unknown> & { params?: Record<string, number> },
  ): Promise<void> {
    const { params = {}, ...columns } = set;
    const result = await manager
      .createQueryBuilder()
      .update(Balance)
      .set({ ...columns, version: () => 'version + 1' })
      .where('id = :id AND version = :expectedVersion')
      .setParameters({ id, expectedVersion, ...params })
      .execute();

    if (!result.affected) {
      throw new OccConflictError('balances', id);
    }
  }
}

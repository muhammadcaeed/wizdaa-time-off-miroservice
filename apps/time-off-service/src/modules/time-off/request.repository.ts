import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, type EntityManager } from 'typeorm';
import { InvalidTransitionError } from '../../common/errors/invalid-transition.error';
import { TimeOffRequest } from '../../database/entities';
import type { RequestStatus } from './request-state-machine';

/** Fields required to insert a new request row (T-01). */
export type NewRequest = Pick<
  TimeOffRequest,
  | 'id'
  | 'employeeId'
  | 'locationId'
  | 'startDate'
  | 'endDate'
  | 'daysRequested'
  | 'status'
  | 'submittedAt'
> &
  Partial<Pick<TimeOffRequest, 'reason'>>;

/** Mutable fields a status transition may set alongside the new status. */
export type RequestPatch = Partial<
  Pick<TimeOffRequest, 'decidedBy' | 'decidedAt' | 'hcmCorrelationId' | 'failureReason'>
>;

/** Request statuses whose `days_requested` count toward `Balance.reserved_days` (INV-03). */
const RESERVING_STATUSES: readonly RequestStatus[] = ['SUBMITTED', 'APPROVING', 'CANCELLING'];

/**
 * Data access for {@link TimeOffRequest}. Status changes use a status-predicate
 * CAS (`WHERE id = :id AND status = :from`); a zero-row result means another
 * writer already transitioned the row, surfaced as {@link InvalidTransitionError}
 * (409, no retry — TRD §5.3, §10.2). Mutating methods take the active
 * {@link EntityManager} so they join the caller's transaction.
 */
@Injectable()
export class RequestRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async insert(request: NewRequest, manager: EntityManager): Promise<void> {
    await manager.getRepository(TimeOffRequest).insert(request);
  }

  async findById(
    id: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<TimeOffRequest | null> {
    return manager.getRepository(TimeOffRequest).findOne({ where: { id } });
  }

  /**
   * Atomically transitions a request from `from` to `to`, applying `patch`.
   * @throws InvalidTransitionError when the row is not currently in `from`
   */
  async casStatus(
    id: string,
    from: RequestStatus,
    to: RequestStatus,
    patch: RequestPatch,
    manager: EntityManager,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(TimeOffRequest)
      .set({ ...patch, status: to })
      .where('id = :id AND status = :from', { id, from })
      .execute();

    if (!result.affected) {
      throw new InvalidTransitionError(id);
    }
  }

  /**
   * Sum of `days_requested` across reserving statuses for an (employee, location)
   * pair. The source-of-truth side of the INV-03 reservation check (TRD §4.3).
   */
  async sumReservedDays(
    employeeId: string,
    locationId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    const raw = await manager
      .getRepository(TimeOffRequest)
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.days_requested), 0)', 'sum')
      .where('r.employee_id = :employeeId AND r.location_id = :locationId', {
        employeeId,
        locationId,
      })
      .andWhere({ status: In(RESERVING_STATUSES) })
      .getRawOne<{ sum: number }>();

    return Number(raw?.sum ?? 0);
  }
}

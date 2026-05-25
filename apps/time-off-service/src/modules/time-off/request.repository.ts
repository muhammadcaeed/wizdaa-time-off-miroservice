import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, LessThan, type EntityManager } from 'typeorm';
import { InvalidTransitionError } from '../../common/errors/invalid-transition.error';
import { RequestCursorError } from '../../common/errors/request-cursor.error';
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
 * Keyset cursor over the `(submitted_at, id)` sort key. `submitted_at` alone is
 * not unique (two requests can share a millisecond on SQLite), so `id` is the
 * tie-break that keeps the page boundary stable (api-contract.md §5).
 */
interface RequestListCursor {
  submittedAt: string;
  id: string;
}

/** Query options for {@link RequestRepository.list}. */
export interface ListRequestsQuery {
  limit?: number;
  cursor?: string;
  status?: string;
}

/** A page of requests plus the opaque cursor to resume after (api-contract.md §5). */
export interface RequestPage {
  data: TimeOffRequest[];
  pagination: { next_cursor: string | null; has_more: boolean };
}

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
   * Returns requests stuck in a transient saga state (APPROVING or CANCELLING)
   * whose `updated_at` predates `cutoff` (i.e. older than `thresholdMs`).
   * Ordered oldest-first so chronically-failing rows don't starve newer ones
   * (REQ-DEF-11, F-07, TRD §11.1).
   * @param thresholdMs age in milliseconds; rows with `updatedAt < (now - thresholdMs)` are returned
   * @returns stuck requests, oldest first
   */
  async findStuckRequests(thresholdMs: number): Promise<TimeOffRequest[]> {
    const cutoff = new Date(Date.now() - thresholdMs);
    return this.dataSource.manager.getRepository(TimeOffRequest).find({
      where: [
        { status: 'APPROVING', updatedAt: LessThan(cutoff) },
        { status: 'CANCELLING', updatedAt: LessThan(cutoff) },
      ],
      order: { updatedAt: 'ASC' },
    });
  }

  /**
   * Lists requests newest-first with opaque keyset cursor pagination (REQ-LIST-01,
   * api-contract.md §5). The page is sorted by `(submitted_at DESC, id DESC)`;
   * the cursor encodes the last row of the previous page so the next page resumes
   * with the keyset predicate `(submitted_at, id) < (cursor)`. One extra row is
   * fetched to compute `has_more` without a second COUNT query.
   *
   * The `submittedAt` cursor field is passed as a `Date` to TypeORM so it uses the
   * same datetime transformer it used to store the column — a raw ISO string with
   * `T`/`Z` would not match SQLite's stored `YYYY-MM-DD HH:MM:SS.SSS` format.
   *
   * @param employeeId the employee to scope to, or null for admin/all
   * @param query `limit`, `cursor`, and optional `status` filter
   * @param manager optional entity manager; defaults to the shared connection
   * @returns the page rows plus the next cursor and a has-more flag
   * @throws RequestCursorError when the cursor is malformed
   */
  async list(
    employeeId: string | null,
    query: ListRequestsQuery,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<RequestPage> {
    const pageSize = query.limit ?? 20;
    const qb = manager
      .getRepository(TimeOffRequest)
      .createQueryBuilder('r')
      .orderBy('r.submitted_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      // Fetch one extra row: its presence is the has-more signal.
      .take(pageSize + 1);

    // Employee scope — null means admin sees everything.
    if (employeeId !== null) {
      qb.andWhere('r.employee_id = :employeeId', { employeeId });
    }

    // Optional status filter.
    if (query.status !== undefined) {
      qb.andWhere('r.status = :status', { status: query.status });
    }

    // Keyset cursor predicate — applied after scope and status filters so the
    // cursor only navigates within the already-filtered set.
    if (query.cursor !== undefined) {
      const decoded = this.decodeRequestCursor(query.cursor);
      // SQLite lacks row-value comparison in TypeORM's builder, so expand:
      // submitted_at < c.submittedAt, OR equal submitted_at with a smaller id.
      // The bound is passed as a Date so TypeORM serializes it with the same
      // datetime transformer it used to store the column.
      qb.andWhere(
        '(r.submitted_at < :submittedAt) OR (r.submitted_at = :submittedAt AND r.id < :id)',
        { submittedAt: new Date(decoded.submittedAt), id: decoded.id },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > pageSize;
    const data = hasMore ? rows.slice(0, pageSize) : rows;
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? this.encodeRequestCursor(last) : null;
    return { data, pagination: { next_cursor: nextCursor, has_more: hasMore } };
  }

  /** Base64-encodes the `(submitted_at, id)` keyset of a row into an opaque cursor. */
  private encodeRequestCursor(row: TimeOffRequest): string {
    const payload: RequestListCursor = {
      submittedAt:
        row.submittedAt instanceof Date ? row.submittedAt.toISOString() : String(row.submittedAt),
      id: row.id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  /** Decodes an opaque cursor back into its `(submitted_at, id)` keyset. */
  private decodeRequestCursor(cursor: string): RequestListCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as RequestListCursor).submittedAt === 'string' &&
        typeof (parsed as RequestListCursor).id === 'string'
      ) {
        const cursorValue = parsed as RequestListCursor;
        // A structurally-valid cursor can still carry a non-date submittedAt; an
        // unparseable date would silently become an Invalid Date and corrupt the
        // keyset predicate, so reject it as malformed like a JSON parse failure.
        if (Number.isNaN(new Date(cursorValue.submittedAt).getTime())) {
          throw new RequestCursorError();
        }
        return cursorValue;
      }
    } catch (err) {
      if (err instanceof RequestCursorError) throw err;
      // JSON parse or structural failure — fall through
    }
    throw new RequestCursorError();
  }

  /**
   * Sum of `days_requested` across reserving statuses for an (employee, location)
   * pair. The source-of-truth side of the INV-03 reservation check (TRD §4.2).
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

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In, QueryFailedError } from 'typeorm';
import { ReconciliationCursorError } from '../../common/errors/reconciliation-cursor.error';
import { ReconciliationInProgressError } from '../../common/errors/reconciliation-in-progress.error';
import {
  Reconciliation,
  type ReconciliationStatus,
  type ReconciliationTrigger,
} from '../../database/entities/reconciliation.entity';

/** Statuses that count as a finished, successful run for `since` derivation. */
const COMPLETED_STATUSES: readonly ReconciliationStatus[] = [
  'COMPLETED',
  'COMPLETED_WITH_CONFLICTS',
];

/** SQLite/better-sqlite3 message fragment for the partial UNIQUE-index violation. */
const UNIQUE_VIOLATION_FRAGMENT = 'UNIQUE constraint failed';

/** Default page size for {@link ReconciliationRepository.list} (api-contract.md §5). */
const DEFAULT_LIST_LIMIT = 50;

/** Maximum page size; a larger client-supplied limit is clamped down (api-contract.md §5). */
const MAX_LIST_LIMIT = 100;

/**
 * Keyset cursor over the `(started_at, id)` sort key. `started_at` alone is not
 * unique (two runs can share a millisecond on SQLite), so `id` is the tie-break
 * that keeps the page boundary stable — without it a cursor would skip or
 * duplicate rows under that collision (api-contract.md §5).
 */
interface ListCursor {
  startedAt: string;
  id: string;
}

/** A page of runs plus the opaque cursor to resume after (api-contract.md §5). */
export interface ReconciliationPage {
  data: Reconciliation[];
  pagination: { next_cursor: string | null; has_more: boolean };
}

/**
 * Data access for {@link Reconciliation} runs (TRD §9.3, §4.2). The partial
 * UNIQUE index `uq_reconciliations_single_running` enforces at most one RUNNING
 * row; a violation on insert is surfaced as {@link ReconciliationInProgressError}
 * (409, REQ-REC-06). Mutating methods take the active {@link EntityManager} so
 * the write joins the caller's transaction.
 */
@Injectable()
export class ReconciliationRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Inserts a fresh RUNNING run. The partial UNIQUE index admits only one
   * RUNNING row at a time, so a concurrent run collides here (REQ-REC-06).
   * @param since inclusive lower bound for the HCM batch query
   * @param trigger what initiated the run (SCHEDULED or ON_DEMAND)
   * @param manager the active transaction's entity manager
   * @returns the persisted RUNNING run
   * @throws ReconciliationInProgressError when another run is already RUNNING
   */
  async createRunning(
    since: Date,
    trigger: ReconciliationTrigger,
    manager: EntityManager,
  ): Promise<Reconciliation> {
    const repo = manager.getRepository(Reconciliation);
    const run = repo.create({
      status: 'RUNNING',
      since,
      startedAt: new Date(),
      completedAt: null,
      balancesExamined: 0,
      conflicts: 0,
      triggerType: trigger,
    });

    try {
      return await repo.save(run);
    } catch (err) {
      // The partial UNIQUE index is the single source of the concurrency guard;
      // any other failure is a real fault and must propagate untranslated.
      if (err instanceof QueryFailedError && err.message.includes(UNIQUE_VIOLATION_FRAGMENT)) {
        throw new ReconciliationInProgressError();
      }
      throw err;
    }
  }

  /**
   * Most recent successfully-finished run's `completed_at`, used to derive the
   * next run's `since` (REQ-REC-01).
   * @param manager optional entity manager; defaults to the shared connection
   * @returns the latest completed run's `completed_at`, or null if none exists
   */
  async lastCompletedAt(manager: EntityManager = this.dataSource.manager): Promise<Date | null> {
    const latest = await manager.getRepository(Reconciliation).findOne({
      where: { status: In(COMPLETED_STATUSES) },
      order: { completedAt: 'DESC' },
    });
    return latest?.completedAt ?? null;
  }

  /**
   * Finalizes a run with its terminal outcome (REQ-REC-04).
   * @param id the run id
   * @param status COMPLETED or COMPLETED_WITH_CONFLICTS
   * @param balancesExamined count of balances examined across all pages
   * @param conflicts count of critical conflicts observed
   * @param manager optional entity manager; defaults to the shared connection
   * @returns nothing; the run row is updated in place
   */
  async complete(
    id: string,
    status: Extract<ReconciliationStatus, 'COMPLETED' | 'COMPLETED_WITH_CONFLICTS'>,
    balancesExamined: number,
    conflicts: number,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    await manager.getRepository(Reconciliation).update(id, {
      status,
      balancesExamined,
      conflicts,
      completedAt: new Date(),
    });
  }

  /**
   * Marks a run FAILED after an unrecoverable mid-run error (e.g. HCM read
   * failure), stamping `completed_at` so the run is no longer RUNNING.
   * @param id the run id
   * @param manager optional entity manager; defaults to the shared connection
   * @returns nothing; the run row is updated in place
   */
  async fail(id: string, manager: EntityManager = this.dataSource.manager): Promise<void> {
    await manager.getRepository(Reconciliation).update(id, {
      status: 'FAILED',
      completedAt: new Date(),
    });
  }

  /**
   * Loads a single run by id.
   * @param id the run id
   * @param manager optional entity manager; defaults to the shared connection
   * @returns the run, or null if no run has that id
   */
  async findById(
    id: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Reconciliation | null> {
    return manager.getRepository(Reconciliation).findOne({ where: { id } });
  }

  /**
   * Lists runs newest-first with opaque keyset cursor pagination (REQ-REC-01
   * surface, api-contract.md §5). The page is sorted by `(started_at, id)`
   * descending; the cursor encodes the last row of the previous page so the next
   * page resumes with the keyset predicate `(started_at, id) < (cursor)`. One
   * extra row is fetched to compute `has_more` without a second COUNT query.
   * @param limit requested page size; clamped to {@link MAX_LIST_LIMIT}, defaults
   *   to {@link DEFAULT_LIST_LIMIT}
   * @param cursor opaque cursor from a prior page's `next_cursor`; omit to start
   *   from the newest run
   * @param manager optional entity manager; defaults to the shared connection
   * @returns the page rows plus the next cursor and a has-more flag
   * @throws ReconciliationCursorError when the cursor is malformed (the service
   *   generates every cursor, so a bad one is a client error, not a server fault)
   */
  async list(
    limit: number = DEFAULT_LIST_LIMIT,
    cursor?: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ReconciliationPage> {
    const pageSize = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
    const qb = manager
      .getRepository(Reconciliation)
      .createQueryBuilder('r')
      .orderBy('r.started_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      // Fetch one extra row: its presence is the has-more signal.
      .take(pageSize + 1);

    if (cursor !== undefined) {
      const decoded = this.decodeCursor(cursor);
      // Keyset predicate over the composite (started_at, id) sort key. SQLite
      // lacks row-value comparison in TypeORM's builder, so it is expanded:
      // started_at < c.startedAt, OR equal started_at with a smaller id. The
      // bound is passed as a Date so TypeORM serializes it with the same
      // datetime transformer it used to store the column — a raw ISO string
      // (with `T`/`Z`) would not match SQLite's stored `YYYY-MM-DD HH:MM:SS.SSS`.
      qb.where('(r.started_at < :startedAt) OR (r.started_at = :startedAt AND r.id < :id)', {
        startedAt: new Date(decoded.startedAt),
        id: decoded.id,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > pageSize;
    const data = hasMore ? rows.slice(0, pageSize) : rows;
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? this.encodeCursor(last) : null;
    return { data, pagination: { next_cursor: nextCursor, has_more: hasMore } };
  }

  /** Base64-encodes the `(started_at, id)` keyset of a row into an opaque cursor. */
  private encodeCursor(row: Reconciliation): string {
    const payload: ListCursor = { startedAt: row.startedAt.toISOString(), id: row.id };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  /** Decodes an opaque cursor back into its `(started_at, id)` keyset. */
  private decodeCursor(cursor: string): ListCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as ListCursor).startedAt === 'string' &&
        typeof (parsed as ListCursor).id === 'string'
      ) {
        return parsed as ListCursor;
      }
    } catch {
      // fall through to the typed error below
    }
    throw new ReconciliationCursorError();
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In, QueryFailedError } from 'typeorm';
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

/** Default page size for {@link ReconciliationRepository.list} until the controller sub-task refines it. */
const DEFAULT_LIST_LIMIT = 50;

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
   * Lists runs newest-first for the admin history view (REQ-REC-01 surface).
   * @param limit max rows to return; defaults to {@link DEFAULT_LIST_LIMIT}
   * @param manager optional entity manager; defaults to the shared connection
   * @returns runs ordered by `started_at` descending
   */
  async list(
    limit: number = DEFAULT_LIST_LIMIT,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Reconciliation[]> {
    // TODO(cycle-04 sub-task 2): add opaque cursor pagination for the controller.
    return manager.getRepository(Reconciliation).find({
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }
}

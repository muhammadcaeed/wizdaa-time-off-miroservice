import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../../common/audit/audit.service';
import { OccConflictError } from '../../common/persistence/occ-conflict.error';
import type { Balance } from '../../database/entities';
import {
  Reconciliation,
  type ReconciliationTrigger,
} from '../../database/entities/reconciliation.entity';
import { BalanceRepository } from '../balances/balance.repository';
import { CircuitBreaker } from '../hcm-sync/circuit-breaker';
import { HCM_READER, type HcmBalanceRow, type HcmReader } from '../hcm-sync/hcm-reader';
import { RequestRepository } from '../time-off/request.repository';
import type { PointReconciler } from './point-reconciliation-queue';
import { ReconciliationRepository } from './reconciliation.repository';

/** Epoch lower bound for the first-ever run: reconcile the full corpus (REQ-REC-01). */
const EPOCH = new Date(0);

/** Per-row reconciliation outcome accumulated into the run totals. */
interface RowOutcome {
  examined: 1;
  conflict: 0 | 1;
}

/**
 * The batch and point reconciliation engine (TRD §9.3, §9.3). HCM is the source
 * of truth for `total_days`; the service owns `reserved_days` and refuses to
 * violate INV-02 (`total - reserved >= 0`) even when HCM disagrees. Implements
 * {@link PointReconciler} so the async point-reconciliation queue (ADR-011) can
 * drive it without a circular concrete dependency.
 *
 * Transaction discipline: each balance row reconciles in its OWN transaction
 * (TRD §9.3 "each balance reconciliation is transactional"), never one
 * transaction spanning a whole page, so a partial run leaves the DB consistent
 * and a single OCC loss can't roll back already-reconciled rows.
 */
@Injectable()
export class ReconciliationService implements PointReconciler {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reconciliationRepository: ReconciliationRepository,
    private readonly balanceRepository: BalanceRepository,
    private readonly requestRepository: RequestRepository,
    @Inject(HCM_READER) private readonly hcmReader: HcmReader,
    private readonly breaker: CircuitBreaker,
    private readonly auditService: AuditService,
    @InjectPinoLogger(ReconciliationService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Runs the scheduled batch reconciliation (TRD §9.3). When the breaker is
   * hard-OPEN the run is skipped entirely — no Reconciliation row is created —
   * because hammering an unreachable HCM is pointless and the next scheduled
   * run resumes from the same `since` (TRD §9.2 "Operations during OPEN").
   * @returns nothing; outcomes are persisted to the run and the audit log
   */
  async runScheduled(): Promise<void> {
    if (this.breaker.isHardOpen()) {
      this.logger.info(
        { event: 'reconciliation.skipped_breaker_open' },
        'breaker OPEN; skipping scheduled reconciliation',
      );
      return;
    }
    await this.run('SCHEDULED');
  }

  /**
   * Runs an admin-initiated batch reconciliation (REQ-REC-01). Unlike the
   * scheduled run it does NOT breaker-skip: an admin asks for it deliberately,
   * and surfacing a failed run is more useful than a silent skip.
   * @returns the finalized run (COMPLETED, COMPLETED_WITH_CONFLICTS, or FAILED)
   * @throws ReconciliationInProgressError when another run is already RUNNING
   */
  async runOnDemand(): Promise<Reconciliation> {
    return this.run('ON_DEMAND');
  }

  /**
   * Drives one batch run end to end: derive `since`, create the RUNNING row in
   * its own short transaction (so the concurrency 409 surfaces before any HCM
   * I/O), page the HCM batch endpoint reconciling each row in its own
   * transaction, then finalize (REQ-REC-04).
   * @param trigger what initiated the run
   * @returns the reloaded, finalized run
   * @throws ReconciliationInProgressError when another run is already RUNNING
   */
  private async run(trigger: ReconciliationTrigger): Promise<Reconciliation> {
    const since = (await this.reconciliationRepository.lastCompletedAt()) ?? EPOCH;

    // Short, dedicated transaction so the UNIQUE-violation -> 409 surfaces
    // immediately, before any HCM round-trip (REQ-REC-06).
    const run = await this.dataSource.transaction((manager) =>
      this.reconciliationRepository.createRunning(since, trigger, manager),
    );

    let balancesExamined = 0;
    let conflicts = 0;

    try {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.hcmReader.getBatch(since, cursor);
        for (const row of page.rows) {
          const outcome = await this.reconcileOneBatchRow(run.id, row);
          balancesExamined += outcome.examined;
          conflicts += outcome.conflict;
        }
        cursor = page.nextCursor ?? undefined;
        if (!page.hasMore) {
          break;
        }
      }
    } catch (err) {
      // A read failure mid-run (HcmServerError/timeout/transport) leaves the run
      // unfinishable. Mark it FAILED for visibility and rethrow so an ON_DEMAND
      // caller sees it; the scheduler (a later sub-task) logs and swallows.
      await this.reconciliationRepository.fail(run.id);
      this.logger.error({ err, runId: run.id }, 'reconciliation run failed');
      throw err;
    }

    const status = conflicts === 0 ? 'COMPLETED' : 'COMPLETED_WITH_CONFLICTS';
    await this.reconciliationRepository.complete(run.id, status, balancesExamined, conflicts);

    const finalized = await this.reconciliationRepository.findById(run.id);
    if (!finalized) {
      // Unreachable: we just wrote this row in the same connection.
      throw new Error(`reconciliation run ${run.id} vanished after completion`);
    }
    return finalized;
  }

  /**
   * Reconciles a single HCM batch row against its local balance in its own
   * transaction (TRD §9.3). The local read is INSIDE the transaction so the
   * observed `version` is fresh for the CAS that follows.
   * @param runId the owning run id, used as the audit correlation id
   * @param row the HCM-sourced balance row
   * @returns examined count (always 1) and conflict count (0 or 1)
   */
  private async reconcileOneBatchRow(runId: string, row: HcmBalanceRow): Promise<RowOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const local = await this.balanceRepository.findByEmployeeAndLocation(
        row.employeeId,
        row.locationId,
        manager,
      );

      // Reconciliation mirrors EXISTING employees; it never creates a balance.
      // An absent local row would also risk an Employee/Location FK violation.
      if (!local) {
        // No identifying ids in the log (REQ-DEF-09); the runId scopes it to the
        // run and the audit trail (not emitted here, no row to attach to) is the
        // PII-bearing channel.
        this.logger.info(
          { event: 'balance.reconciliation.skipped_unknown', runId },
          'no local balance for HCM row; skipping',
        );
        return { examined: 1, conflict: 0 };
      }

      if (row.totalDays === local.totalDays) {
        await this.balanceRepository.touchHcmSyncAt(local.id, manager);
        return { examined: 1, conflict: 0 };
      }

      return this.applyDrift(runId, row, local, manager, 'BATCH', {
        reconciledAction: 'balance.reconciled',
        conflictAction: 'balance.reconciliation.conflict',
      });
    });
  }

  /**
   * Reconciles one balance against the HCM realtime read (TRD §9.3), the
   * fire-and-forget point variant. Resilient by contract: it is invoked from the
   * queue and must never throw on the expected breaker-open or no-drift paths.
   * @param employeeId the employee whose balance to refresh
   * @param locationId the location of the balance to refresh
   * @param context optional correlation id + reason from the triggering flow,
   *   recorded on the point-path audit row for cross-flow traceability
   * @returns nothing; drift is corrected or a conflict is audited
   */
  async reconcilePoint(
    employeeId: string,
    locationId: string,
    context?: { correlationId?: string; reason?: string },
  ): Promise<void> {
    if (this.breaker.isHardOpen()) {
      // Surrogate keys only (REQ-DEF-09): the triggering correlationId locates
      // the flow; raw employee/location ids live solely on audit rows.
      this.logger.info(
        {
          event: 'balance.point_reconciliation.skipped_breaker_open',
          correlationId: context?.correlationId,
        },
        'breaker OPEN; skipping point reconciliation (batch backstop)',
      );
      return;
    }

    // The HCM read is an HTTP round-trip; it stays OUTSIDE the DB transaction so
    // no SQLite write connection is held open across the network call (TRD §10.4
    // commit-boundary discipline; the §9.3 pseudocode shows it inside only for
    // narrative clarity).
    const rows = await this.hcmReader.getBalances(employeeId);
    const hcmRow = rows.find((r) => r.locationId === locationId);
    if (!hcmRow) {
      return; // HCM does not know this (employee, location): no drift.
    }

    await this.dataSource.transaction(async (manager) => {
      const local = await this.balanceRepository.findByEmployeeAndLocation(
        employeeId,
        locationId,
        manager,
      );
      if (!local || hcmRow.totalDays === local.totalDays) {
        return; // unknown balance or no drift.
      }
      // The audit correlationId is the triggering flow's id (saga/drift), not
      // the balance row id, so the point-recon row joins that flow's audits.
      await this.applyDrift(context?.correlationId ?? local.id, hcmRow, local, manager, 'POINT', {
        reconciledAction: 'balance.point_reconciled',
        conflictAction: 'balance.point_reconciliation.conflict',
        reason: context?.reason,
      });
    });
  }

  /**
   * Shared drift-resolution body for the batch and point paths (TRD §9.3
   * conflict rules): HCM wins for `total_days`, local owns `reserved_days`
   * (recomputed from in-flight requests, INV-03). Updates only when the new
   * total can support the reservations; otherwise audits a conflict and leaves
   * the balance untouched (REQ-REC-03). An OCC loss means a concurrent saga won
   * the version race — treated as a non-conflict no-op (idempotent; the next run
   * catches any residual drift).
   */
  private async applyDrift(
    correlationId: string,
    hcm: HcmBalanceRow,
    local: Balance,
    manager: EntityManager,
    mode: 'BATCH' | 'POINT',
    actions: { reconciledAction: string; conflictAction: string; reason?: string },
  ): Promise<RowOutcome> {
    const { reconciledAction, conflictAction, reason } = actions;
    const reserved = await this.requestRepository.sumReservedDays(
      hcm.employeeId,
      hcm.locationId,
      manager,
    );

    if (hcm.totalDays - reserved < 0) {
      // HCM total can't support existing reservations: refuse to update (INV-02).
      await this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'BALANCE',
          entityId: local.id,
          action: conflictAction,
          correlationId,
          metadata: { hcmTotalDays: hcm.totalDays, reserved, reason },
        },
        manager,
      );
      return { examined: 1, conflict: 1 };
    }

    // Snapshot BEFORE the CAS so the audit before-state carries the stale values.
    const beforeState = {
      totalDays: local.totalDays,
      reservedDays: local.reservedDays,
      version: local.version,
    };

    try {
      if (mode === 'POINT') {
        // §9.3: the point path sets total_days ONLY; reserved is locally owned.
        await this.balanceRepository.casReconcileTotal(
          local.id,
          local.version,
          hcm.totalDays,
          manager,
        );
      } else {
        // §9.3: the batch path also writes reserved_days. The value is the
        // recomputed sum of in-flight reservations, so this is an INV-03
        // reassertion (same value by definition), not a semantic change.
        await this.balanceRepository.casReconcile(
          local.id,
          local.version,
          hcm.totalDays,
          reserved,
          manager,
        );
      }
    } catch (err) {
      if (err instanceof OccConflictError) {
        // Expected churn under concurrency, not a fault: a saga committed between
        // our read and write. Skip; the next run reconciles any residual drift.
        this.logger.info(
          { event: 'balance.reconciliation.occ_skip', balanceId: local.id },
          'concurrent writer won the version race; skipping this row',
        );
        return { examined: 1, conflict: 0 };
      }
      throw err;
    }

    await this.auditService.record(
      {
        actorType: 'SYSTEM',
        entityType: 'BALANCE',
        entityId: local.id,
        action: reconciledAction,
        beforeState,
        // POINT writes total only (§9.3), so reserved is unchanged; BATCH (§9.3)
        // reasserts the recomputed reserved sum.
        afterState: {
          totalDays: hcm.totalDays,
          reservedDays: mode === 'POINT' ? local.reservedDays : reserved,
        },
        correlationId,
        metadata: { reason },
      },
      manager,
    );
    return { examined: 1, conflict: 0 };
  }
}

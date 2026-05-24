import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { AuditService } from '../../common/audit/audit.service';
import { CircuitBreaker } from '../hcm-sync/circuit-breaker';
import { HCM_READER, type HcmReader } from '../hcm-sync/hcm-reader';
import {
  POINT_RECONCILIATION_QUEUE,
  type PointReconciliationQueue,
} from './point-reconciliation-queue';

/** The HCM balance operation a drift check follows up on. */
export type DriftOp = 'decrement' | 'increment';

/** Audit reason recorded on the enqueued point reconciliation for a drift event. */
const DRIFT_REASON = 'post_commit_drift';

/**
 * Post-commit drift sanity check (REQ-SYNC-04a, TRD §9.4 item 3). After a saga
 * commits a balance change, this asynchronously re-reads the HCM total and, if it
 * disagrees with what the service just committed locally, emits a
 * `hcm.<op>.drift_detected` audit row and enqueues a point reconciliation to fix
 * the local total out of band.
 *
 * It runs strictly AFTER the commit and never rolls anything back — a drift check
 * failure must not destabilize a committed transition. Work is scheduled on
 * `process.nextTick` and tracked in an in-flight set so tests can {@link drain}
 * deterministically (same pattern as {@link NextTickPointReconciliationQueue}).
 */
@Injectable()
export class DriftDetectionService {
  /** In-flight scheduled checks, tracked so {@link drain} can await them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(HCM_READER) private readonly reader: HcmReader,
    private readonly breaker: CircuitBreaker,
    private readonly auditService: AuditService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(POINT_RECONCILIATION_QUEUE) private readonly pointQueue: PointReconciliationQueue,
    @InjectPinoLogger(DriftDetectionService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Schedules a post-commit drift check and returns immediately (REQ-SYNC-04a).
   * Fire-and-forget: never adds latency to the saga response and never throws
   * back to the caller.
   * @param employeeId the employee whose HCM total to re-read
   * @param locationId the location of the balance just committed
   * @param op the operation that committed (`decrement` on approve, `increment`
   *   on a cancel/reject release)
   * @param committedTotal the local `total_days` the saga just committed
   * @param requestId the originating request id; the audit `entity_id`, joining
   *   the drift row to the saga's other HCM-call audits
   * @param correlationId the saga's correlation id, carried onto the audit row
   * @returns nothing; the check runs out of band
   */
  scheduleDriftCheck(
    employeeId: string,
    locationId: string,
    op: DriftOp,
    committedTotal: number,
    requestId: string,
    correlationId: string,
  ): void {
    const work = new Promise<void>((resolve) => {
      process.nextTick(async () => {
        try {
          await this.check(employeeId, locationId, op, committedTotal, requestId, correlationId);
        } catch (err) {
          // Swallow: the saga response is already sent; the batch reconciler is the backstop.
          // Surrogate keys only (REQ-DEF-09): correlationId locates the flow; the
          // raw employee/location ids belong to AuditLog rows, never the log.
          this.logger.error({ err, correlationId, op }, 'post-commit drift check failed');
        } finally {
          this.inFlight.delete(work);
          resolve();
        }
      });
    });
    // Register synchronously so a drain() in the same microtask observes the job.
    this.inFlight.add(work);
  }

  /**
   * Awaits all drift checks in flight at call time so tests can assert
   * deterministically.
   * @returns a promise that resolves once those checks have settled
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** The scheduled work: re-read HCM, compare, audit + enqueue on disagreement. */
  private async check(
    employeeId: string,
    locationId: string,
    op: DriftOp,
    committedTotal: number,
    requestId: string,
    correlationId: string,
  ): Promise<void> {
    if (this.breaker.isHardOpen()) {
      // Surrogate keys only (REQ-DEF-09): correlationId + op, not the raw ids.
      this.logger.info(
        { event: 'drift.skipped_breaker_open', correlationId, op },
        'breaker OPEN; skipping post-commit drift check (batch backstop)',
      );
      return;
    }

    const rows = await this.reader.getBalances(employeeId);
    const hcmRow = rows.find((r) => r.locationId === locationId);
    if (!hcmRow || hcmRow.totalDays === committedTotal) {
      return; // HCM agrees (or doesn't know this balance): no drift.
    }

    await this.dataSource.transaction((manager) =>
      this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'HCM_CALL',
          entityId: requestId,
          action: `hcm.${op}.drift_detected`,
          correlationId,
          metadata: {
            localTotal: committedTotal,
            hcmTotal: hcmRow.totalDays,
            deltaObserved: hcmRow.totalDays - committedTotal,
          },
        },
        manager,
      ),
    );
    this.pointQueue.enqueue({ employeeId, locationId, reason: DRIFT_REASON, correlationId });
  }
}

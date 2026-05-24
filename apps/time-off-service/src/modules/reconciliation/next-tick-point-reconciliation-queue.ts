import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  POINT_RECONCILER,
  type PointReconciler,
  type PointReconciliationJob,
  type PointReconciliationQueue,
} from './point-reconciliation-queue';

/**
 * Default in-process {@link PointReconciliationQueue} (ADR-011). Work is
 * scheduled on `process.nextTick` so it never blocks the saga response
 * (REQ-SYNC-04a), and any failure is logged and swallowed — a point recon must
 * never roll back or destabilize a committed transition.
 *
 * Durability note: a process crash drops in-flight jobs. This is acceptable
 * only because the scheduled batch reconciler (TRD §9.3) is the backstop that
 * eventually catches the same drift. That dependency is load-bearing.
 */
@Injectable()
export class NextTickPointReconciliationQueue implements PointReconciliationQueue {
  /** In-flight scheduled jobs, tracked so {@link drain} can await them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(POINT_RECONCILER) private readonly reconciler: PointReconciler,
    @InjectPinoLogger(NextTickPointReconciliationQueue.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Schedules a point reconciliation on the next tick and returns immediately.
   * @param job the balance to reconcile plus its audit reason
   * @returns nothing; the work runs out of band and never throws back here
   */
  enqueue(job: PointReconciliationJob): void {
    const work = new Promise<void>((resolve) => {
      process.nextTick(async () => {
        try {
          await this.reconciler.reconcilePoint(job.employeeId, job.locationId, {
            correlationId: job.correlationId,
            reason: job.reason,
          });
        } catch (err) {
          // Swallow: the saga response is already sent; the batch reconciler is the backstop.
          this.logger.error({ err, job }, 'point reconciliation failed');
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
   * Awaits all jobs in flight at call time so tests can assert deterministically.
   * @returns a promise that resolves once those jobs have settled
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}

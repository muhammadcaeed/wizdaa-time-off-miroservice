/** DI token for the {@link PointReconciliationQueue} abstraction. */
export const POINT_RECONCILIATION_QUEUE = Symbol('POINT_RECONCILIATION_QUEUE');

/** DI token for the {@link PointReconciler} abstraction. */
export const POINT_RECONCILER = Symbol('POINT_RECONCILER');

/**
 * A request to refresh one `(employee, location)` balance from the HCM realtime
 * read (TRD §9.7). `reason` is the audit discriminator for the call site
 * (F-04 ambiguous adjust, F-05 HCM 409, or post-commit drift; ADR-011).
 */
export interface PointReconciliationJob {
  employeeId: string;
  locationId: string;
  reason: string;
}

/**
 * The narrow capability that performs a single point reconciliation (DIP/ISP).
 * The queue depends on this abstraction; the concrete reconciler is wired in a
 * later sub-task. Tests substitute a fake.
 */
export interface PointReconciler {
  /**
   * Reconciles one balance against the HCM realtime read (TRD §9.7).
   * @param employeeId the employee whose balance to refresh
   * @param locationId the location of the balance to refresh
   * @returns a promise that settles when the local balance is reconciled
   */
  reconcilePoint(employeeId: string, locationId: string): Promise<void>;
}

/**
 * A fire-and-forget queue for point reconciliations (ADR-011). Enqueuing must
 * never add latency to or destabilize the saga response that triggered it
 * (REQ-SYNC-04a): work is scheduled out of band and failures are swallowed.
 */
export interface PointReconciliationQueue {
  /**
   * Schedules a point reconciliation to run out of band; returns immediately.
   * @param job the balance to reconcile plus its audit reason
   * @returns nothing; the work runs asynchronously and never throws back here
   */
  enqueue(job: PointReconciliationJob): void;
}

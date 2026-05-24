import type { PinoLogger } from 'nestjs-pino';
import { NextTickPointReconciliationQueue } from './next-tick-point-reconciliation-queue';
import type { PointReconciler, PointReconciliationJob } from './point-reconciliation-queue';

/** Minimal PinoLogger stand-in; the queue only calls `.error`. */
function fakeLogger(): PinoLogger {
  return { error: () => undefined } as unknown as PinoLogger;
}

const JOB: PointReconciliationJob = {
  employeeId: 'emp_001',
  locationId: 'loc_001',
  reason: 'post-commit-drift',
};

/**
 * @req REQ-SYNC-04a
 */
describe('NextTickPointReconciliationQueue', () => {
  it('runs the enqueued job after drain', async () => {
    const calls: Array<[string, string]> = [];
    const reconciler: PointReconciler = {
      reconcilePoint: (employeeId, locationId) => {
        calls.push([employeeId, locationId]);
        return Promise.resolve();
      },
    };
    const queue = new NextTickPointReconciliationQueue(reconciler, fakeLogger());

    queue.enqueue(JOB);
    await queue.drain();

    expect(calls).toEqual([['emp_001', 'loc_001']]);
  });

  it('swallows a throwing reconciler so drain still resolves', async () => {
    const reconciler: PointReconciler = {
      reconcilePoint: () => Promise.reject(new Error('HCM read failed')),
    };
    const queue = new NextTickPointReconciliationQueue(reconciler, fakeLogger());

    queue.enqueue(JOB);

    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('runs every job when several are enqueued before draining', async () => {
    let runs = 0;
    const reconciler: PointReconciler = {
      reconcilePoint: () => {
        runs += 1;
        return Promise.resolve();
      },
    };
    const queue = new NextTickPointReconciliationQueue(reconciler, fakeLogger());

    queue.enqueue(JOB);
    queue.enqueue(JOB);
    queue.enqueue(JOB);
    await queue.drain();

    expect(runs).toBe(3);
  });
});

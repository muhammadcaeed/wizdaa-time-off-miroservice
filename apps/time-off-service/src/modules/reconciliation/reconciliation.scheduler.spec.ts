import type { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { PinoLogger } from 'nestjs-pino';
import type { ReconciliationService } from './reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';

/**
 * @req REQ-REC-01
 */
describe('ReconciliationScheduler', () => {
  const INTERVAL_MS = 3_600_000;

  /** Minimal ConfigService stub returning the two keys the scheduler reads. */
  function configStub(nodeEnv: string): ConfigService {
    return {
      get: (key: string) => (key === 'NODE_ENV' ? nodeEnv : undefined),
      getOrThrow: (key: string) => {
        if (key === 'RECONCILE_INTERVAL_MS') return INTERVAL_MS;
        throw new Error(`unexpected key ${key}`);
      },
    } as unknown as ConfigService;
  }

  const logger = { info: () => undefined, error: () => undefined } as unknown as PinoLogger;

  let runScheduled: ReturnType<typeof vi.fn>;
  let service: ReconciliationService;

  beforeEach(() => {
    runScheduled = vi.fn().mockResolvedValue(undefined);
    service = { runScheduled } as unknown as ReconciliationService;
  });

  it('resolves the configured period from RECONCILE_INTERVAL_MS', () => {
    const scheduler = new ReconciliationScheduler(
      new SchedulerRegistry(),
      configStub('production'),
      service,
      logger,
    );
    expect(scheduler.getIntervalMs()).toBe(INTERVAL_MS);
  });

  it('registers no real interval under NODE_ENV=test', () => {
    const registry = new SchedulerRegistry();
    const scheduler = new ReconciliationScheduler(registry, configStub('test'), service, logger);

    scheduler.onModuleInit();

    expect(registry.getIntervals()).toHaveLength(0);
  });

  it('registers an interval driving runScheduled outside test', () => {
    vi.useFakeTimers();
    try {
      const registry = new SchedulerRegistry();
      const scheduler = new ReconciliationScheduler(
        registry,
        configStub('production'),
        service,
        logger,
      );

      scheduler.onModuleInit();

      const intervals = registry.getIntervals();
      expect(intervals).toHaveLength(1);

      // Advancing past the configured period fires the registered callback,
      // which targets runScheduled().
      vi.advanceTimersByTime(INTERVAL_MS);
      expect(runScheduled).toHaveBeenCalledTimes(1);

      // Stop the timer so the fake-timer teardown is clean.
      registry.deleteInterval(intervals[0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

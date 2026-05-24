import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ReconciliationService } from './reconciliation.service';

/** Name the dynamic interval is registered under, for observability/teardown. */
const INTERVAL_NAME = 'reconciliation.scheduled';

/** Env value that suppresses real timers so test runs never auto-fire. */
const TEST_ENV = 'test';

/**
 * Registers the periodic batch reconciliation (REQ-REC-01, TRD §9.3, §14.4). The
 * interval period is read from `RECONCILE_INTERVAL_MS`; its callback drives
 * {@link ReconciliationService.runScheduled} (which breaker-skips when HCM is
 * hard-down).
 *
 * Under `NODE_ENV=test` no real interval is registered: a live timer would fire
 * `runScheduled()` mid-suite and race the deterministic assertions. The scheduled
 * behavior is verified instead by calling `runScheduled()` directly and by
 * asserting {@link getIntervalMs} resolves the configured period.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit {
  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
    private readonly reconciliationService: ReconciliationService,
    @InjectPinoLogger(ReconciliationScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Registers the reconciliation interval on boot unless running under test.
   * @returns nothing
   */
  onModuleInit(): void {
    // Production correctness depends on NODE_ENV being unset or non-'test': only
    // a 'test' value suppresses the interval, so a misconfigured env silently
    // disables scheduled reconciliation in production.
    if (this.configService.get<string>('NODE_ENV') === TEST_ENV) {
      this.logger.info(
        { event: 'reconciliation.scheduler.suppressed' },
        'NODE_ENV=test; not registering the reconciliation interval',
      );
      return;
    }

    const periodMs = this.getIntervalMs();
    const interval = setInterval(() => {
      void this.reconciliationService.runScheduled().catch((err: unknown) => {
        // A scheduled run failure must not crash the timer; the next tick retries.
        this.logger.error({ err }, 'scheduled reconciliation run failed');
      });
    }, periodMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
    this.logger.info(
      { event: 'reconciliation.scheduler.registered', periodMs },
      'registered scheduled reconciliation interval',
    );
  }

  /**
   * Resolves the configured reconciliation period from `RECONCILE_INTERVAL_MS`.
   * Exposed so a unit test can assert the period without driving a real timer.
   * @returns the interval period in milliseconds
   */
  getIntervalMs(): number {
    return this.configService.getOrThrow<number>('RECONCILE_INTERVAL_MS');
  }
}

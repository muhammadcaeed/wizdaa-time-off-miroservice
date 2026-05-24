import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { StuckStateSweepService } from './stuck-state-sweep.service';

/** Name the dynamic interval is registered under, for observability/teardown. */
const INTERVAL_NAME = 'stuck-state-sweep.scheduled';

/** Env value that suppresses real timers so test runs never auto-fire. */
const TEST_ENV = 'test';

/**
 * Registers the periodic stuck-state sweep (REQ-DEF-11, TRD §11.1 F-07, Plan 06).
 * The interval period is read from `STUCK_STATE_SWEEP_INTERVAL_MS`; its callback
 * drives {@link StuckStateSweepService.runSweep} (which breaker-skips when HCM is
 * hard-down, REQ-DEF-12).
 *
 * Under `NODE_ENV=test` no real interval is registered: a live timer would fire
 * `runSweep()` mid-suite and race the deterministic assertions. The scheduled
 * behavior is verified instead by calling `runSweep()` directly.
 */
@Injectable()
export class StuckStateSweepScheduler implements OnModuleInit {
  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
    private readonly stuckStateSweepService: StuckStateSweepService,
    @InjectPinoLogger(StuckStateSweepScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Registers the stuck-state sweep interval on boot unless running under test.
   * @returns nothing
   */
  onModuleInit(): void {
    if (this.configService.get<string>('NODE_ENV') === TEST_ENV) {
      this.logger.info(
        { event: 'stuck-state-sweep.scheduler.suppressed' },
        'NODE_ENV=test; not registering the stuck-state sweep interval',
      );
      return;
    }

    const periodMs = this.getIntervalMs();
    const interval = setInterval(() => {
      void this.stuckStateSweepService.runSweep().catch((err: unknown) => {
        // A sweep run failure must not crash the timer; the next tick retries.
        this.logger.error({ err }, 'stuck-state sweep run failed');
      });
    }, periodMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
    this.logger.info(
      { event: 'stuck-state-sweep.scheduler.registered', periodMs },
      'registered stuck-state sweep interval',
    );
  }

  /**
   * Resolves the configured sweep period from `STUCK_STATE_SWEEP_INTERVAL_MS`.
   * Exposed so a unit test can assert the period without driving a real timer.
   * @returns the interval period in milliseconds
   */
  getIntervalMs(): number {
    return this.configService.getOrThrow<number>('STUCK_STATE_SWEEP_INTERVAL_MS');
  }
}

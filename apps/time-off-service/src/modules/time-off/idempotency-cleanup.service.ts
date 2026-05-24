import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { IdempotencyService } from './idempotency.service';

/**
 * Periodic cleanup for expired idempotency records. Runs every hour via the
 * NestJS schedule module (api-contract.md §6, IDEMPOTENCY_TTL_HOURS default 24h).
 */
@Injectable()
export class IdempotencyCleanupService {
  constructor(
    private readonly idempotency: IdempotencyService,
    @InjectPinoLogger(IdempotencyCleanupService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Removes all idempotency records whose `expires_at` is in the past.
   * Fire-and-forget on schedule — errors are logged but not propagated.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCleanup(): Promise<void> {
    try {
      await this.idempotency.cleanup();
      this.logger.debug('idempotency records cleanup completed');
    } catch (err) {
      this.logger.error({ err }, 'idempotency records cleanup failed');
    }
  }
}

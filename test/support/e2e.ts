import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getLoggerToken, type PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { AppModule } from '../../apps/time-off-service/src/app.module';
import { InitSchema1779625818136 } from '../../apps/time-off-service/src/database/migrations/1779625818136-InitSchema';
import { CircuitBreaker } from '../../apps/time-off-service/src/modules/hcm-sync/circuit-breaker';
import { HCM_ADJUSTER, type HcmAdjuster } from '../../apps/time-off-service/src/modules/hcm-sync/hcm-adjuster';
import { HCM_READER } from '../../apps/time-off-service/src/modules/hcm-sync/hcm-reader';
import { HcmClient } from '../../apps/time-off-service/src/modules/hcm-sync/hcm-client';
import { HcmReaderClient } from '../../apps/time-off-service/src/modules/hcm-sync/hcm-reader-client';
import { ResilientHcmAdjuster } from '../../apps/time-off-service/src/modules/hcm-sync/resilient-hcm-adjuster';

export interface BootstrapOptions {
  /** Override the HCM adjuster (e.g. a real client pointed at an in-test mock). */
  hcmAdjuster?: HcmAdjuster;
  /**
   * Point the REAL resilience stack (retry + the DI {@link CircuitBreaker}) at
   * the given mock HCM base URL. Unlike `hcmAdjuster`, this keeps the breaker the
   * saga's entry pre-gate reads and the adjuster's gate the SAME instance, which
   * is required to exercise breaker-trip behavior end-to-end. Backoff sleeps are
   * collapsed to keep the suite fast.
   */
  hcmBaseUrl?: string;
  /**
   * Override the shared {@link CircuitBreaker}'s cool-down (ms). Lets a recovery
   * test wait out OPEN→HALF_OPEN in a few hundred ms instead of the 30s default,
   * without relying on env-load ordering. Other breaker thresholds stay env-driven.
   */
  breakerCooldownMs?: number;
}

export interface E2EContext {
  app: INestApplication;
  /** Typed HTTP server for supertest (avoids the `any` from `getHttpServer`). */
  httpServer: Server;
  dataSource: DataSource;
  close: () => Promise<void>;
}

/**
 * Boots the full Nest app and applies the committed migration to the app's own
 * DataSource (never `synchronize`, per requirements.md §2.3). Migrating the live
 * connection — rather than a separate file — sidesteps ConfigModule's env
 * snapshot and works with the in-memory test DB, which persists for the
 * connection's lifetime.
 */
export async function bootstrapE2E(options: BootstrapOptions = {}): Promise<E2EContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.breakerCooldownMs !== undefined) {
    const cooldownMs = options.breakerCooldownMs;
    builder = builder.overrideProvider(CircuitBreaker).useFactory({
      inject: [ConfigService, getLoggerToken(CircuitBreaker.name)],
      factory: (config: ConfigService, logger: PinoLogger) =>
        new CircuitBreaker(
          {
            failureThreshold: config.getOrThrow<number>('HCM_BREAKER_FAILURE_THRESHOLD'),
            failureRate: config.getOrThrow<number>('HCM_BREAKER_FAILURE_RATE'),
            cooldownMs,
            probeDeadlineMs: config.getOrThrow<number>('HCM_BREAKER_PROBE_DEADLINE_MS'),
          },
          Date.now,
          logger,
        ),
    });
  }
  if (options.hcmAdjuster) {
    builder = builder.overrideProvider(HCM_ADJUSTER).useValue(options.hcmAdjuster);
    // When a raw adjuster is supplied, also point the HcmClient DI provider at the
    // same base URL (if the adjuster IS an HcmClient) so the stuck-state sweep,
    // which injects HcmClient directly, hits the same mock. We derive the URL from
    // the adjuster instance only when it is an HcmClient; otherwise callers that
    // need the sweep override should use `hcmBaseUrl` instead.
    if (options.hcmAdjuster instanceof HcmClient) {
      builder = builder.overrideProvider(HcmClient).useValue(options.hcmAdjuster);
    }
  } else if (options.hcmBaseUrl) {
    const baseUrl = options.hcmBaseUrl;
    builder = builder.overrideProvider(HCM_ADJUSTER).useFactory({
      inject: [CircuitBreaker, ConfigService, getLoggerToken(ResilientHcmAdjuster.name)],
      factory: (breaker: CircuitBreaker, config: ConfigService, logger: PinoLogger) => {
        const client = new HcmClient(baseUrl, config.getOrThrow<number>('HCM_TIMEOUT_MS'));
        const policy = {
          maxAttempts: config.getOrThrow<number>('HCM_RETRY_MAX_ATTEMPTS'),
          baseMs: config.getOrThrow<number>('HCM_RETRY_BASE_MS'),
        };
        return new ResilientHcmAdjuster(client, breaker, policy, () => 0.5, async () => {}, logger);
      },
    });
    // Point the raw HcmClient DI provider at the same mock so the stuck-state
    // sweep (which injects HcmClient directly) uses the correct base URL.
    builder = builder.overrideProvider(HcmClient).useFactory({
      inject: [ConfigService],
      factory: (config: ConfigService) =>
        new HcmClient(baseUrl, config.getOrThrow<number>('HCM_TIMEOUT_MS')),
    });
    // Point the READ side at the same in-test mock so reconciliation and the
    // post-commit drift check (REQ-SYNC-04a) hit the same HCM the saga adjusts.
    builder = builder.overrideProvider(HCM_READER).useFactory({
      inject: [ConfigService],
      factory: (config: ConfigService) =>
        new HcmReaderClient(baseUrl, config.getOrThrow<number>('HCM_TIMEOUT_MS')),
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const dataSource = app.get(DataSource);
  const queryRunner = dataSource.createQueryRunner();
  try {
    await new InitSchema1779625818136().up(queryRunner);
  } finally {
    await queryRunner.release();
  }

  return {
    app,
    httpServer: app.getHttpServer() as Server,
    dataSource,
    close: async () => {
      await app.close();
    },
  };
}

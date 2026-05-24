import { randomInt } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker';
import { HcmAdminController } from './hcm-admin.controller';
import { HCM_ADJUSTER } from './hcm-adjuster';
import { HcmClient } from './hcm-client';
import { HCM_READER } from './hcm-reader';
import { HcmReaderClient } from './hcm-reader-client';
import { ResilientHcmAdjuster } from './resilient-hcm-adjuster';
import type { RetryPolicy, Rng } from './retry-policy';

/** Resolution of the float jitter in {@link defaultRng} (one part in a million). */
const RNG_RESOLUTION = 1_000_000;

/** Crypto-backed RNG in [0, 1); production jitter source for backoff. */
const defaultRng: Rng = () => randomInt(RNG_RESOLUTION) / RNG_RESOLUTION;

/** Promise-based sleep; production backoff delay. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HCM integration surface. Binds {@link HCM_ADJUSTER} to a
 * {@link ResilientHcmAdjuster} (ADR-008) wrapping a {@link HcmClient} with a
 * shared {@link CircuitBreaker} and the retry policy, all built from validated
 * env. Consumers (saga, future sweep/reconciliation) depend only on the token,
 * so the resilience layer slotted in without touching them.
 */
@Module({
  controllers: [HcmAdminController],
  providers: [
    {
      provide: CircuitBreaker,
      inject: [ConfigService, getLoggerToken(CircuitBreaker.name)],
      useFactory: (config: ConfigService, logger: PinoLogger): CircuitBreaker => {
        const breakerConfig: CircuitBreakerConfig = {
          failureThreshold: config.getOrThrow<number>('HCM_BREAKER_FAILURE_THRESHOLD'),
          failureRate: config.getOrThrow<number>('HCM_BREAKER_FAILURE_RATE'),
          cooldownMs: config.getOrThrow<number>('HCM_BREAKER_COOLDOWN_MS'),
          probeDeadlineMs: config.getOrThrow<number>('HCM_BREAKER_PROBE_DEADLINE_MS'),
        };
        return new CircuitBreaker(breakerConfig, Date.now, logger);
      },
    },
    {
      provide: HCM_ADJUSTER,
      inject: [ConfigService, CircuitBreaker, getLoggerToken(ResilientHcmAdjuster.name)],
      useFactory: (
        config: ConfigService,
        breaker: CircuitBreaker,
        logger: PinoLogger,
      ): ResilientHcmAdjuster => {
        const client = new HcmClient(
          config.getOrThrow<string>('HCM_BASE_URL'),
          config.getOrThrow<number>('HCM_TIMEOUT_MS'),
        );
        const policy: RetryPolicy = {
          maxAttempts: config.getOrThrow<number>('HCM_RETRY_MAX_ATTEMPTS'),
          baseMs: config.getOrThrow<number>('HCM_RETRY_BASE_MS'),
        };
        return new ResilientHcmAdjuster(client, breaker, policy, defaultRng, defaultSleep, logger);
      },
    },
    {
      // Plain typed read client (TRD §9.1). Deliberately NOT breaker-wrapped:
      // breaker-gating of reads is the consumer's responsibility (a later
      // sub-task), so the reader stays a thin client here.
      provide: HCM_READER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): HcmReaderClient =>
        new HcmReaderClient(
          config.getOrThrow<string>('HCM_BASE_URL'),
          config.getOrThrow<number>('HCM_TIMEOUT_MS'),
        ),
    },
  ],
  exports: [HCM_ADJUSTER, HCM_READER, CircuitBreaker],
})
export class HcmSyncModule {}

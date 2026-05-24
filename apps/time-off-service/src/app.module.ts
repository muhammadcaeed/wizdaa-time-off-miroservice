import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AuditModule } from './common/audit/audit.module';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { envValidationSchema } from './config/env.validation';
import { buildDataSourceOptions } from './database/data-source';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { RolesGuard } from './modules/auth/roles.guard';
import { BalancesModule } from './modules/balances/balances.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { TimeOffModule } from './modules/time-off/time-off.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.getOrThrow<string>('LOG_LEVEL'),
          /**
           * Single source of truth for the correlation ID (REQ-LOG-01).
           *
           * pino-http calls genReqId *before* any application middleware, so this
           * is the correct place to extract or generate the ID. The result is
           * stored as req.id and later echoed by CorrelationIdMiddleware via the
           * x-correlation-id response header.
           */
          genReqId: (req: IncomingMessage): string => {
            const existing = req.headers['x-correlation-id'];
            return (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
          },
          /**
           * Surfaces req.id as `correlationId` in every pino log line so log
           * aggregators can group all log entries for a single HTTP request.
           */
          customProps: (req: IncomingMessage) => ({
            correlationId: (req as IncomingMessage & { id?: string }).id,
          }),
          /**
           * PII redaction (REQ-PII-01).
           *
           * Pino's fast-redact censors these paths *before* the log line is
           * serialised to stdout. The values are retained in the audit_logs DB
           * table, which is written separately and not affected by this config.
           *
           * Path semantics:
           *  - `req.body.*` — request body fields logged by pino-http
           *  - `*.email` / `*.firstName` / `*.lastName` — service-level log
           *    objects one level deep (e.g. `logger.info({ employee, ... })`)
           */
          redact: {
            paths: [
              'req.body.email',
              'req.body.firstName',
              'req.body.lastName',
              '*.email',
              '*.firstName',
              '*.lastName',
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions(config.getOrThrow<string>('DATABASE_FILE')),
    }),
    AuthModule,
    AuditModule,
    BalancesModule,
    TimeOffModule,
    ReconciliationModule,
  ],
  providers: [
    // Global authentication, then coarse role gate, then domain-error mapping.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  /**
   * Applies CorrelationIdMiddleware globally.
   *
   * pino-http (registered by LoggerModule) runs first and sets req.id.
   * This middleware reads req.id and echoes it as the x-correlation-id
   * response header so clients can correlate their traces.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}

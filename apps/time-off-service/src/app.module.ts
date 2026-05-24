import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit/audit.module';
import { SubThrottlerGuard } from './common/throttler/sub-throttler.guard';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';
import { envValidationSchema } from './config/env.validation';
import { buildDataSourceOptions } from './database/data-source';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { RolesGuard } from './modules/auth/roles.guard';
import { BalancesModule } from './modules/balances/balances.module';
import { HealthModule } from './modules/health/health.module';
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
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions(config.getOrThrow<string>('DATABASE_FILE')),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'ip',
            ttl: 60_000,
            limit: config.getOrThrow<number>('THROTTLE_PER_IP_PER_MIN'),
          },
          {
            name: 'sub',
            ttl: 60_000,
            limit: config.getOrThrow<number>('THROTTLE_PER_SUB_PER_MIN'),
          },
        ],
      }),
    }),
    AuthModule,
    AuditModule,
    BalancesModule,
    HealthModule,
    TimeOffModule,
    ReconciliationModule,
  ],
  providers: [
    // Guard order matters: auth sets req.principal, then roles gate checks it,
    // then throttler reads it for subject-based tracking.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: SubThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}

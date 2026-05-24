import { forwardRef, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BalancesModule } from '../balances/balances.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { IdempotencyCleanupService } from './idempotency-cleanup.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import { ApprovalSagaService } from './sagas/approval-saga.service';
import { ApprovalRetryService } from './sagas/approval-retry.service';
import { CancellationSagaService } from './sagas/cancellation-saga.service';
import { CancellationRetryService } from './sagas/cancellation-retry.service';
import { StuckStateSweepScheduler } from './stuck-state-sweep.scheduler';
import { StuckStateSweepService } from './stuck-state-sweep.service';
import { TimeOffController } from './time-off.controller';

/**
 * Request lifecycle: submission (T-01), approval saga (T-02/03/04), cancellation
 * saga (T-09/10/11), admin retry endpoints (T-05, T-12), stuck-state sweep
 * (Cycle 06, REQ-DEF-11, F-07), and client-facing idempotency (Cycle 07,
 * REQ-IDEM-01 through REQ-IDEM-05).
 *
 * Imports {@link BalancesModule} for the shared {@link BalanceRepository} and
 * {@link HcmSyncModule} for the HCM adjuster. Auth/audit are global.
 *
 * Imports {@link ReconciliationModule} (via `forwardRef`, as it imports this
 * module back for {@link RequestRepository}) so the approval saga and retry
 * services can inject the point-reconciliation queue and
 * {@link DriftDetectionService}: F-04/F-05 enqueue a point recon and a
 * successful commit schedules the post-commit drift check
 * (REQ-SYNC-04/04a/08, ADR-011). {@link SchedulerRegistry} is available because
 * {@link ReconciliationModule} already imports {@link ScheduleModule.forRoot}.
 *
 * {@link IdempotencyInterceptor} is registered as a module-scoped
 * {@link APP_INTERCEPTOR} so it applies only to this module's controllers
 * (TimeOffController). It only acts on POST requests with an Idempotency-Key
 * header; all other requests pass through transparently.
 */
@Module({
  imports: [BalancesModule, HcmSyncModule, forwardRef(() => ReconciliationModule)],
  controllers: [TimeOffController],
  providers: [
    RequestService,
    RequestRepository,
    ApprovalSagaService,
    ApprovalRetryService,
    CancellationSagaService,
    CancellationRetryService,
    StuckStateSweepService,
    StuckStateSweepScheduler,
    IdempotencyService,
    IdempotencyCleanupService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [RequestRepository],
})
export class TimeOffModule {}

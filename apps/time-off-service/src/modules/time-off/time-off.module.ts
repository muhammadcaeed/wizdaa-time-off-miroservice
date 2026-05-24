import { forwardRef, Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import { ApprovalSagaService } from './sagas/approval-saga.service';
import { CancellationSagaService } from './sagas/cancellation-saga.service';
import { StuckStateSweepScheduler } from './stuck-state-sweep.scheduler';
import { StuckStateSweepService } from './stuck-state-sweep.service';
import { TimeOffController } from './time-off.controller';

/**
 * Request lifecycle: submission (T-01), approval saga (T-02/03/04), cancellation
 * saga (T-09/10/11), and stuck-state sweep (Cycle 06, REQ-DEF-11, F-07).
 *
 * Imports {@link BalancesModule} for the shared {@link BalanceRepository} and
 * {@link HcmSyncModule} for the HCM adjuster + {@link HcmClient} (the sweep
 * uses the raw client directly to avoid the resilience stack's arithmetic check
 * tripping the circuit breaker on case-2 idempotent replays). Auth/audit are global.
 *
 * Imports {@link ReconciliationModule} (via `forwardRef`, as it imports this
 * module back for {@link RequestRepository}) so the approval saga can inject the
 * point-reconciliation queue and {@link DriftDetectionService}: F-04/F-05 enqueue
 * a point recon and a successful commit schedules the post-commit drift check
 * (REQ-SYNC-04/04a/08, ADR-011). {@link SchedulerRegistry} is available because
 * {@link ReconciliationModule} already imports {@link ScheduleModule.forRoot}.
 */
@Module({
  imports: [BalancesModule, HcmSyncModule, forwardRef(() => ReconciliationModule)],
  controllers: [TimeOffController],
  providers: [
    RequestService,
    RequestRepository,
    ApprovalSagaService,
    CancellationSagaService,
    StuckStateSweepService,
    StuckStateSweepScheduler,
  ],
  exports: [RequestRepository],
})
export class TimeOffModule {}

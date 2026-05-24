import { forwardRef, Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import { ApprovalSagaService } from './sagas/approval-saga.service';
import { ApprovalRetryService } from './sagas/approval-retry.service';
import { CancellationSagaService } from './sagas/cancellation-saga.service';
import { CancellationRetryService } from './sagas/cancellation-retry.service';
import { TimeOffController } from './time-off.controller';

/**
 * Request lifecycle: submission (T-01), the approval saga (T-02/03/04),
 * cancellation saga (T-09/10/11), and admin retry endpoints (T-05, T-12).
 * Imports {@link BalancesModule} for the shared {@link BalanceRepository} and
 * {@link HcmSyncModule} for the HCM adjuster; audit/auth are global.
 *
 * Imports {@link ReconciliationModule} (via `forwardRef`, as it imports this
 * module back for {@link RequestRepository}) so the approval saga and retry
 * services can inject the point-reconciliation queue and
 * {@link DriftDetectionService}: F-04/F-05 enqueue a point recon and a
 * successful commit schedules the post-commit drift check
 * (REQ-SYNC-04/04a/08, ADR-011).
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
  ],
  exports: [RequestRepository],
})
export class TimeOffModule {}

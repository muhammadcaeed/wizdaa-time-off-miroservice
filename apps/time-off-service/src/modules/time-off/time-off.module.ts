import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { RequestRepository } from './request.repository';
import { RequestService } from './request.service';
import { ApprovalSagaService } from './sagas/approval-saga.service';
import { TimeOffController } from './time-off.controller';

/**
 * Request lifecycle: submission (T-01) and the approval saga (T-02/03/04).
 * Imports {@link BalancesModule} for the shared {@link BalanceRepository} and
 * {@link HcmSyncModule} for the HCM adjuster; audit/auth are global.
 */
@Module({
  imports: [BalancesModule, HcmSyncModule],
  controllers: [TimeOffController],
  providers: [RequestService, RequestRepository, ApprovalSagaService],
  exports: [RequestRepository],
})
export class TimeOffModule {}

import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BalancesModule } from '../balances/balances.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { TimeOffModule } from '../time-off/time-off.module';
import { DriftDetectionService } from './drift-detection.service';
import { NextTickPointReconciliationQueue } from './next-tick-point-reconciliation-queue';
import { POINT_RECONCILER, POINT_RECONCILIATION_QUEUE } from './point-reconciliation-queue';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { ReconciliationService } from './reconciliation.service';

/**
 * Batch and point reconciliation (TRD §9.3, §9.3, ADR-011). Imports
 * {@link BalancesModule} for the shared {@link BalanceRepository},
 * {@link HcmSyncModule} for {@link HCM_READER} + the shared {@link CircuitBreaker},
 * and {@link TimeOffModule} for {@link RequestRepository} (the reserved
 * recompute, INV-03). The {@link TimeOffModule} import is `forwardRef` because a
 * later sub-task makes TimeOffModule import this module for the point queue,
 * closing a circular module dependency; pre-empting it here keeps that add
 * clean. {@link AuditService} is global.
 *
 * {@link ReconciliationService} is bound to {@link POINT_RECONCILER} via
 * `useExisting` so the queue and the service are the same singleton.
 * {@link ScheduleModule.forRoot} provides the {@link SchedulerRegistry} the
 * {@link ReconciliationScheduler} registers the periodic run with.
 * {@link DriftDetectionService} is exported so the approval saga (in
 * {@link TimeOffModule}) can schedule the post-commit drift check (REQ-SYNC-04a).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    BalancesModule,
    HcmSyncModule,
    forwardRef(() => TimeOffModule),
  ],
  controllers: [ReconciliationController],
  providers: [
    ReconciliationService,
    ReconciliationRepository,
    ReconciliationScheduler,
    DriftDetectionService,
    NextTickPointReconciliationQueue,
    { provide: POINT_RECONCILER, useExisting: ReconciliationService },
    { provide: POINT_RECONCILIATION_QUEUE, useClass: NextTickPointReconciliationQueue },
  ],
  exports: [
    POINT_RECONCILIATION_QUEUE,
    DriftDetectionService,
    ReconciliationService,
    ReconciliationRepository,
  ],
})
export class ReconciliationModule {}

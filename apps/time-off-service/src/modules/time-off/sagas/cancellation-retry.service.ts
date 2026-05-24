import { randomUUID } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { BalanceNotFoundError } from '../../../common/errors/balance-not-found.error';
import { InvalidTransitionError } from '../../../common/errors/invalid-transition.error';
import { RequestNotFoundError } from '../../../common/errors/request-not-found.error';
import { HcmUnavailableError } from '../../../common/errors/hcm-unavailable.error';
import { OccConflictError } from '../../../common/persistence/occ-conflict.error';
import { withOccRetry } from '../../../common/persistence/with-occ-retry';
import { actorTypeOf, type Principal } from '../../auth/principal';
import { HCM_ADJUSTER, type HcmAdjuster } from '../../hcm-sync/hcm-adjuster';
import {
  HcmArithmeticMismatchError,
  HcmBreakerOpenError,
  HcmError,
  HcmInsufficientBalanceError,
  HcmTransportError,
} from '../../hcm-sync/hcm.errors';
import { CircuitBreaker } from '../../hcm-sync/circuit-breaker';
import { BalanceRepository } from '../../balances/balance.repository';
import { DriftDetectionService } from '../../reconciliation/drift-detection.service';
import {
  POINT_RECONCILIATION_QUEUE,
  type PointReconciliationQueue,
} from '../../reconciliation/point-reconciliation-queue';
import { RequestRepository } from '../request.repository';
import { toRequestResponse, type RequestResponse } from '../dto/request-response.dto';
import type { IdempotencyContext } from '../request.service';
import { IdempotencyService } from '../idempotency.service';

/**
 * Admin retry for a stuck CANCELLATION_FAILED request (T-12, TRD §5.2, REQ-LIFE-12).
 *
 * Simpler than {@link ApprovalRetryService}: CANCELLING holds no reservation
 * (APPROVED had already cleared reserved at T-03, per ADR-012), so there is no
 * balance availability check and no re-reservation step.
 *
 * Structure mirrors {@link CancellationSagaService}: three phases with the HCM
 * call outside any DB transaction:
 *
 * 1. T_retry_1 — CANCELLATION_FAILED→CANCELLING (status CAS) + capture pre-total
 *    + audit with `metadata: { retry: true }`.
 * 2. HCM increment with the SAME idempotency key (`<id>:increment`) — HCM returns
 *    the cached result for a replayed key.
 * 3. T_retry_2 — on success: casCommit(total += days, reserved unchanged) +
 *    CANCELLING→CANCELLED + audit. On HCM failure: fail() — CANCELLING→
 *    CANCELLATION_FAILED + audit. NOTE: fail() does NOT call casRelease —
 *    CANCELLING holds no reservation, so a release would corrupt the balance
 *    (ADR-012, same guard as the primary cancellation saga).
 *
 * R-04 fix: inside commit(), compare the fresh balance total to
 * `preTotal + days`; if already applied by reconciliation, skip the total delta.
 */
@Injectable()
export class CancellationRetryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly balanceRepository: BalanceRepository,
    private readonly requestRepository: RequestRepository,
    private readonly auditService: AuditService,
    @Inject(HCM_ADJUSTER) private readonly hcm: HcmAdjuster,
    private readonly breaker: CircuitBreaker,
    @Inject(POINT_RECONCILIATION_QUEUE) private readonly pointQueue: PointReconciliationQueue,
    @Inject(forwardRef(() => DriftDetectionService))
    private readonly driftDetection: DriftDetectionService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  /**
   * Retries a stuck CANCELLATION_FAILED request as an admin (T-12).
   * @param idem optional idempotency context threaded from the interceptor
   * @returns the request in its resulting state (CANCELLED, CANCELLATION_FAILED,
   *   or CANCELLING if the commit was deferred to the sweep)
   * @throws RequestNotFoundError (404) when the request does not exist
   * @throws InvalidTransitionError (409) when the request is not CANCELLATION_FAILED
   * @throws HcmUnavailableError (503) when the breaker is OPEN at entry
   * @req REQ-LIFE-12
   */
  async retry(
    requestId: string,
    actor: Principal,
    idem?: IdempotencyContext,
  ): Promise<RequestResponse> {
    const correlationId = randomUUID();
    const request = await this.requestRepository.findById(requestId);
    if (!request) {
      throw new RequestNotFoundError();
    }
    if (request.status !== 'CANCELLATION_FAILED') {
      throw new InvalidTransitionError(requestId);
    }

    // Pre-gate: fast-fail 503 BEFORE re-entering CANCELLING. CANCELLING→
    // CANCELLATION_FAILED is the failure path; gating here prevents a
    // redundant failure cycle when HCM is known-down (REQ-DEF-07).
    if (this.breaker.isHardOpen()) {
      await this.recordBreakerFastFail(requestId, actor, correlationId);
      throw new HcmUnavailableError();
    }

    const days = request.daysRequested;
    const delta = +days; // INCREMENT: restore the consumed days

    // Phase 1: re-enter CANCELLING + capture pre-total.
    const preTotal = await this.beginRetrying(
      request.id,
      request.employeeId,
      request.locationId,
      actor,
      correlationId,
    );

    // Phase 2: HCM increment with the same idempotency key as the original saga.
    const idempotencyKey = `${request.id}:increment`;
    const hcmRequest = {
      employee_id: request.employeeId,
      location_id: request.locationId,
      delta,
      operation_type: 'INCREMENT',
      idempotency_key: idempotencyKey,
    };
    const startedAt = Date.now();

    try {
      const verified = await this.hcm.adjustBalance({
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta,
        idempotencyKey,
        expectedPreTotal: preTotal,
        sourceReference: `request:${request.id}`,
      });
      const hcmMeta = {
        request: hcmRequest,
        expected_pre_total: preTotal,
        delta,
        duration_ms: Date.now() - startedAt,
        new_total_days: verified.newTotalDays,
        hcm_correlation_id: verified.correlationId,
        outcome: 'confirmed',
        retry: true,
      };
      const committed = await this.commit(
        request.id,
        request.employeeId,
        request.locationId,
        actor,
        days,
        preTotal,
        verified.correlationId,
        correlationId,
        hcmMeta,
        idem,
      );
      if (committed.status === 'CANCELLED') {
        this.driftDetection.scheduleDriftCheck(
          request.employeeId,
          request.locationId,
          'increment',
          preTotal + delta,
          request.id,
          correlationId,
        );
      }
      return committed;
    } catch (err) {
      if (err instanceof HcmBreakerOpenError) {
        const hcmMeta = {
          request: hcmRequest,
          expected_pre_total: preTotal,
          delta,
          duration_ms: Date.now() - startedAt,
          reason: 'hcm_unreachable',
          outcome: 'failed',
          retry: true,
        };
        return this.fail(
          request.id,
          actor,
          new HcmTransportError('HCM breaker opened mid-flight'),
          correlationId,
          hcmMeta,
          idem,
        );
      }
      if (err instanceof HcmError) {
        const hcmMeta = {
          request: hcmRequest,
          expected_pre_total: preTotal,
          delta,
          duration_ms: Date.now() - startedAt,
          expected: preTotal + delta,
          actual: err instanceof HcmArithmeticMismatchError ? err.actual : undefined,
          reason: err.reason,
          outcome: 'failed',
          retry: true,
        };
        const failed = await this.fail(request.id, actor, err, correlationId, hcmMeta, idem);
        if (
          err instanceof HcmInsufficientBalanceError ||
          err instanceof HcmArithmeticMismatchError
        ) {
          this.pointQueue.enqueue({
            employeeId: request.employeeId,
            locationId: request.locationId,
            reason: err.reason,
            correlationId,
          });
        }
        return failed;
      }
      throw err;
    }
  }

  /**
   * T_retry_1: transition to CANCELLING, capture the pre-call local total, audit.
   * No balance check or re-reservation: CANCELLING holds no reservation (ADR-012).
   */
  private async beginRetrying(
    requestId: string,
    employeeId: string,
    locationId: string,
    actor: Principal,
    correlationId: string,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.requestRepository.casStatus(
        requestId,
        'CANCELLATION_FAILED',
        'CANCELLING',
        { decidedBy: actor.sub },
        manager,
      );
      const balance = await this.requireBalance(employeeId, locationId, manager);
      await this.auditService.record(
        {
          actorId: actor.sub,
          actorType: actorTypeOf(actor),
          entityType: 'REQUEST',
          entityId: requestId,
          action: 'request.cancelling',
          beforeState: { status: 'CANCELLATION_FAILED' },
          afterState: { status: 'CANCELLING' },
          metadata: { retry: true },
          correlationId,
        },
        manager,
      );
      return balance.totalDays;
    });
  }

  /**
   * T_retry_2 success: commit the increment (total += days, reserved UNCHANGED),
   * transition to CANCELLED, audit.
   * R-04 fix: skip total delta if reconciliation already applied it.
   * Deliberately does NOT touch reserved_days — CANCELLING holds no reservation
   * (ADR-012).
   */
  private async commit(
    requestId: string,
    employeeId: string,
    locationId: string,
    actor: Principal,
    days: number,
    preTotal: number,
    hcmCorrelationId: string,
    correlationId: string,
    hcmMeta: Record<string, unknown>,
    idem?: IdempotencyContext,
  ): Promise<RequestResponse> {
    const expectedPostTotal = preTotal + days;
    try {
      return await withOccRetry(() =>
        this.dataSource.transaction(async (manager) => {
          const balance = await this.requireBalance(employeeId, locationId, manager);
          const alreadyApplied = balance.totalDays === expectedPostTotal;
          const totalDelta = alreadyApplied ? 0 : +days;
          await this.balanceRepository.casCommit(
            balance.id,
            balance.version,
            totalDelta,
            0,
            hcmCorrelationId,
            manager,
          );
          await this.requestRepository.casStatus(
            requestId,
            'CANCELLING',
            'CANCELLED',
            { hcmCorrelationId, decidedBy: actor.sub, decidedAt: new Date() },
            manager,
          );
          await this.auditService.record(
            {
              actorId: actor.sub,
              actorType: actorTypeOf(actor),
              entityType: 'REQUEST',
              entityId: requestId,
              action: 'request.cancelled',
              afterState: { status: 'CANCELLED' },
              correlationId,
            },
            manager,
          );
          await this.auditService.record(
            {
              actorType: 'SYSTEM',
              entityType: 'HCM_CALL',
              entityId: requestId,
              action: 'hcm.increment.confirmed',
              metadata: hcmMeta,
              correlationId,
            },
            manager,
          );
          const updated = await this.requestRepository.findById(requestId, manager);
          const response = toRequestResponse(updated!);
          // 202 is the cancellation-retry endpoint status code.
          if (idem) {
            await this.idempotencyService.record(idem.key, idem.hash, 202, response, manager);
          }
          return response;
        }),
      );
    } catch (err) {
      if (err instanceof OccConflictError) {
        return this.deferCommit(requestId, correlationId, hcmMeta, idem);
      }
      throw err;
    }
  }

  /**
   * T_retry_2 failure: transition to CANCELLATION_FAILED, audit. Deliberately
   * does NOT call casRelease — CANCELLING holds no reservation, so a release
   * would corrupt the balance (ADR-012 copy-paste hazard, same guard as the
   * primary cancellation saga).
   */
  private async fail(
    requestId: string,
    actor: Principal,
    error: HcmError,
    correlationId: string,
    hcmMeta: Record<string, unknown>,
    idem?: IdempotencyContext,
  ): Promise<RequestResponse> {
    return withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        await this.requestRepository.casStatus(
          requestId,
          'CANCELLING',
          'CANCELLATION_FAILED',
          { failureReason: error.reason, decidedBy: actor.sub, decidedAt: new Date() },
          manager,
        );
        await this.auditService.record(
          {
            actorId: actor.sub,
            actorType: actorTypeOf(actor),
            entityType: 'REQUEST',
            entityId: requestId,
            action: 'request.cancellation_failed',
            afterState: { status: 'CANCELLATION_FAILED', failureReason: error.reason },
            correlationId,
          },
          manager,
        );
        await this.auditService.record(
          {
            actorType: 'SYSTEM',
            entityType: 'HCM_CALL',
            entityId: requestId,
            action: this.failureAction(error),
            metadata: { ...hcmMeta, message: error.message },
            correlationId,
          },
          manager,
        );
        const updated = await this.requestRepository.findById(requestId, manager);
        const response = toRequestResponse(updated!);
        // 202 is the cancellation-retry endpoint status code.
        if (idem) {
          await this.idempotencyService.record(idem.key, idem.hash, 202, response, manager);
        }
        return response;
      }),
    );
  }

  private async deferCommit(
    requestId: string,
    correlationId: string,
    hcmMeta: Record<string, unknown>,
    idem?: IdempotencyContext,
  ): Promise<RequestResponse> {
    const current = await this.requestRepository.findById(requestId);
    const response = toRequestResponse(current!);
    await this.dataSource.transaction(async (manager) => {
      await this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'REQUEST',
          entityId: requestId,
          action: 'lifecycle.commit_deferred',
          metadata: { ...hcmMeta, reason: 'occ_exhausted_after_hcm_confirm' },
          correlationId,
        },
        manager,
      );
      // 202 is the cancellation-retry endpoint status code.
      if (idem) {
        await this.idempotencyService.record(idem.key, idem.hash, 202, response, manager);
      }
    });
    return response;
  }

  private async recordBreakerFastFail(
    requestId: string,
    actor: Principal,
    correlationId: string,
  ): Promise<void> {
    await this.dataSource.transaction((manager) =>
      this.auditService.record(
        {
          actorId: actor.sub,
          actorType: actorTypeOf(actor),
          entityType: 'HCM_CALL',
          entityId: requestId,
          action: 'hcm.breaker.fast_failed',
          metadata: { breaker: this.breaker.snapshot(), reason: 'hcm_unavailable' },
          correlationId,
        },
        manager,
      ),
    );
  }

  private failureAction(error: HcmError): string {
    if (error instanceof HcmArithmeticMismatchError) return 'hcm.increment.ambiguous';
    if (error instanceof HcmInsufficientBalanceError) return 'hcm.increment.insufficient_balance';
    return 'hcm.increment.failed';
  }

  private async requireBalance(employeeId: string, locationId: string, manager: EntityManager) {
    const balance = await this.balanceRepository.findByEmployeeAndLocation(
      employeeId,
      locationId,
      manager,
    );
    if (!balance) {
      throw new BalanceNotFoundError();
    }
    return balance;
  }
}

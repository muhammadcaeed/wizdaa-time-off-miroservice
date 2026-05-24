import { randomUUID } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { BalanceNotFoundError } from '../../../common/errors/balance-not-found.error';
import { InsufficientBalanceError } from '../../../common/errors/insufficient-balance.error';
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
 * Admin retry for a stuck APPROVAL_FAILED request (T-05, TRD §5.2, REQ-LIFE-06).
 *
 * Structure mirrors {@link ApprovalSagaService}: three phases with the HCM call
 * outside any DB transaction (holding a SQLite write tx across HTTP blocks all
 * writers):
 *
 * 1. T_retry_1 — availability check + APPROVAL_FAILED→APPROVING (status CAS) +
 *    re-acquire reservation (reserved += days) + capture pre-total + audit with
 *    `metadata: { retry: true }`.
 * 2. HCM decrement with the SAME idempotency key (`<id>:decrement`) — HCM is
 *    idempotent on a replayed key, so a prior confirmed result is returned as-is.
 *    Note: if the original failure was arithmetic mismatch (F-04) the replay will
 *    deterministically fail again; the admin's recourse is then to discard.
 * 3. T_retry_2 — on success: casCommit + APPROVING→APPROVED + audit. On HCM
 *    failure: fail() — APPROVING→APPROVAL_FAILED + audit.
 *
 * R-04 fix: inside the commit() OCC closure, compare the fresh balance total to
 * the expected post-commit total (`preTotal − days`). If they match, a concurrent
 * reconciliation already absorbed the HCM decrement; skip the total delta and only
 * move the reservation (reserved -= days). See approval-saga.service.ts for the
 * same fix on the primary path.
 */
@Injectable()
export class ApprovalRetryService {
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
   * Retries a stuck APPROVAL_FAILED request as an admin (T-05).
   * @param idem optional idempotency context threaded from the interceptor
   * @returns the request in its resulting state (APPROVED, APPROVAL_FAILED, or
   *   APPROVING if the commit was deferred to the sweep)
   * @throws RequestNotFoundError (404) when the request does not exist
   * @throws InvalidTransitionError (409) when the request is not APPROVAL_FAILED
   * @throws InsufficientBalanceError (409) when days exceed available balance
   * @throws HcmUnavailableError (503) when the breaker is OPEN at entry
   * @req REQ-LIFE-06
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
    if (request.status !== 'APPROVAL_FAILED') {
      throw new InvalidTransitionError(requestId);
    }

    // Pre-gate: fast-fail 503 BEFORE re-entering APPROVING. APPROVING→APPROVAL_FAILED
    // is the failure path (not a forward transition), so leaving APPROVING stuck
    // is handled by the sweep — gating here prevents a redundant failure cycle.
    if (this.breaker.isHardOpen()) {
      await this.recordBreakerFastFail(requestId, actor, correlationId);
      throw new HcmUnavailableError();
    }

    const days = request.daysRequested;
    const delta = -days;

    // Phase 1: availability check + re-enter APPROVING + re-acquire reservation.
    const preTotal = await this.beginRetrying(
      request.id,
      request.employeeId,
      request.locationId,
      actor,
      days,
      correlationId,
    );

    // Phase 2: HCM decrement with the same idempotency key as the original saga.
    // HCM returns the cached result for a replayed key (idempotent by design).
    const idempotencyKey = `${request.id}:decrement`;
    const hcmRequest = {
      employee_id: request.employeeId,
      location_id: request.locationId,
      delta,
      operation_type: 'DECREMENT',
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
      if (committed.status === 'APPROVED') {
        this.driftDetection.scheduleDriftCheck(
          request.employeeId,
          request.locationId,
          'decrement',
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
          request.employeeId,
          request.locationId,
          actor,
          days,
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
        const failed = await this.fail(
          request.id,
          request.employeeId,
          request.locationId,
          actor,
          days,
          err,
          correlationId,
          hcmMeta,
          idem,
        );
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
   * T_retry_1: check availability, re-acquire reservation, transition to APPROVING,
   * capture the pre-call local total, audit with retry metadata.
   */
  private async beginRetrying(
    requestId: string,
    employeeId: string,
    locationId: string,
    actor: Principal,
    days: number,
    correlationId: string,
  ): Promise<number> {
    return withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const balance = await this.requireBalance(employeeId, locationId, manager);
        const available = balance.totalDays - balance.reservedDays;
        if (available < days) {
          throw new InsufficientBalanceError(available, days);
        }
        // Re-acquire the reservation that was released when the request entered
        // APPROVAL_FAILED (T-04 released reserved -= days). `casReserve` does
        // `reserved_days += delta`, which is the re-acquisition.
        await this.balanceRepository.casReserve(balance.id, balance.version, days, manager);
        await this.requestRepository.casStatus(
          requestId,
          'APPROVAL_FAILED',
          'APPROVING',
          { decidedBy: actor.sub },
          manager,
        );
        await this.auditService.record(
          {
            actorId: actor.sub,
            actorType: actorTypeOf(actor),
            entityType: 'REQUEST',
            entityId: requestId,
            action: 'request.approving',
            beforeState: { status: 'APPROVAL_FAILED' },
            afterState: { status: 'APPROVING' },
            metadata: { retry: true },
            correlationId,
          },
          manager,
        );
        return balance.totalDays;
      }),
    );
  }

  /**
   * T_retry_2 success: commit the decrement, transition to APPROVED, audit.
   * R-04 fix: compare fresh balance total to expectedPostTotal; if already applied
   * by reconciliation, skip the total delta and only clear the reservation.
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
    const expectedPostTotal = preTotal + -days; // preTotal - days
    try {
      return await withOccRetry(() =>
        this.dataSource.transaction(async (manager) => {
          const balance = await this.requireBalance(employeeId, locationId, manager);
          const alreadyApplied = balance.totalDays === expectedPostTotal;
          const totalDelta = alreadyApplied ? 0 : -days;
          await this.balanceRepository.casCommit(
            balance.id,
            balance.version,
            totalDelta,
            -days,
            hcmCorrelationId,
            manager,
          );
          await this.requestRepository.casStatus(
            requestId,
            'APPROVING',
            'APPROVED',
            { hcmCorrelationId, decidedBy: actor.sub, decidedAt: new Date() },
            manager,
          );
          await this.auditService.record(
            {
              actorId: actor.sub,
              actorType: actorTypeOf(actor),
              entityType: 'REQUEST',
              entityId: requestId,
              action: 'request.approved',
              afterState: { status: 'APPROVED' },
              correlationId,
            },
            manager,
          );
          await this.auditService.record(
            {
              actorType: 'SYSTEM',
              entityType: 'HCM_CALL',
              entityId: requestId,
              action: 'hcm.decrement.confirmed',
              metadata: hcmMeta,
              correlationId,
            },
            manager,
          );
          const updated = await this.requestRepository.findById(requestId, manager);
          const response = toRequestResponse(updated!);
          // 202 is the approval-retry endpoint status code.
          await this.idempotencyService.record(idem?.key, idem?.hash ?? '', 202, response, manager);
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
   * T_retry_2 failure: release the reservation, transition to APPROVAL_FAILED, audit.
   */
  private async fail(
    requestId: string,
    employeeId: string,
    locationId: string,
    actor: Principal,
    days: number,
    error: HcmError,
    correlationId: string,
    hcmMeta: Record<string, unknown>,
    idem?: IdempotencyContext,
  ): Promise<RequestResponse> {
    return withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const balance = await this.requireBalance(employeeId, locationId, manager);
        await this.balanceRepository.casRelease(balance.id, balance.version, -days, manager);
        await this.requestRepository.casStatus(
          requestId,
          'APPROVING',
          'APPROVAL_FAILED',
          { failureReason: error.reason, decidedBy: actor.sub, decidedAt: new Date() },
          manager,
        );
        await this.auditService.record(
          {
            actorId: actor.sub,
            actorType: actorTypeOf(actor),
            entityType: 'REQUEST',
            entityId: requestId,
            action: 'request.approval_failed',
            afterState: { status: 'APPROVAL_FAILED', failureReason: error.reason },
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
        // 202 is the approval-retry endpoint status code.
        await this.idempotencyService.record(idem?.key, idem?.hash ?? '', 202, response, manager);
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
      // 202 is the approval-retry endpoint status code.
      await this.idempotencyService.record(idem?.key, idem?.hash ?? '', 202, response, manager);
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
    if (error instanceof HcmArithmeticMismatchError) return 'hcm.decrement.ambiguous';
    if (error instanceof HcmInsufficientBalanceError) return 'hcm.decrement.insufficient_balance';
    return 'hcm.decrement.failed';
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

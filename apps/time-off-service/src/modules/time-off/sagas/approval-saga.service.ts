import { randomUUID } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { BalanceNotFoundError } from '../../../common/errors/balance-not-found.error';
import { ForbiddenError } from '../../../common/errors/forbidden.error';
import { RequestNotFoundError } from '../../../common/errors/request-not-found.error';
import { OccConflictError } from '../../../common/persistence/occ-conflict.error';
import { withOccRetry } from '../../../common/persistence/with-occ-retry';
import { actorTypeOf, type Principal } from '../../auth/principal';
import { AuthorizationService } from '../../auth/authorization.service';
import { HcmUnavailableError } from '../../../common/errors/hcm-unavailable.error';
import { CircuitBreaker } from '../../hcm-sync/circuit-breaker';
import { HCM_ADJUSTER, type HcmAdjuster } from '../../hcm-sync/hcm-adjuster';
import {
  HcmArithmeticMismatchError,
  HcmBreakerOpenError,
  HcmError,
  HcmInsufficientBalanceError,
  HcmTransportError,
} from '../../hcm-sync/hcm.errors';
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
 * Forward approval saga (TRD §3.2 Flow B, §10.4). Three phases with the HCM call
 * outside any DB transaction (holding a SQLite write tx across HTTP would block
 * all writers):
 *
 * 1. T_local_1 — status SUBMITTED→APPROVING (status CAS) + capture pre-total + audit.
 * 2. HCM decrement (key `<id>:decrement`), then the expected-total arithmetic check.
 * 3. T_local_2 — on success: balance total/reserved −= days (version CAS) +
 *    status→APPROVED + audit. On any HCM failure: release reservation +
 *    status→APPROVAL_FAILED + audit.
 *
 * If the post-HCM commit loses the version race past the retry budget, the
 * request is left APPROVING for the stuck-state sweep (Plan 06) — never
 * force-committed (R-04, TRD §11.1 F-06).
 */
@Injectable()
export class ApprovalSagaService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly balanceRepository: BalanceRepository,
    private readonly requestRepository: RequestRepository,
    private readonly auditService: AuditService,
    private readonly authorization: AuthorizationService,
    @Inject(HCM_ADJUSTER) private readonly hcm: HcmAdjuster,
    private readonly breaker: CircuitBreaker,
    @Inject(POINT_RECONCILIATION_QUEUE) private readonly pointQueue: PointReconciliationQueue,
    // forwardRef: TimeOffModule <-> ReconciliationModule are mutually importing.
    @Inject(forwardRef(() => DriftDetectionService))
    private readonly driftDetection: DriftDetectionService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  /**
   * Approves a SUBMITTED request as the acting manager/admin.
   * @param idem optional idempotency context threaded from the interceptor
   * @returns the request in its terminal saga state (APPROVED or APPROVAL_FAILED),
   *   or APPROVING if the commit was deferred to the sweep
   * @throws RequestNotFoundError (404) when the request does not exist
   * @throws ForbiddenError (403) when the actor may not approve it
   * @throws InvalidTransitionError (409) when the request is not SUBMITTED
   * @throws HcmUnavailableError (503) when the breaker is OPEN at entry — the
   *   request stays SUBMITTED, never entering a transient state (REQ-SYNC-06,
   *   REQ-DEF-07, TRD §11.2)
   */
  async execute(
    requestId: string,
    actor: Principal,
    idem?: IdempotencyContext,
  ): Promise<RequestResponse> {
    const correlationId = randomUUID();
    const request = await this.requestRepository.findById(requestId);
    if (!request) {
      // Hide existence from non-admins so request ids can't be enumerated
      // (REQ-DEF-10); admins, who see everything, get a true 404.
      throw this.authorization.canSeeExistence(actor)
        ? new RequestNotFoundError()
        : new ForbiddenError();
    }
    await this.authorization.assertCanApprove(actor, request.employeeId);

    // Pre-gate: if the breaker is OPEN AND still cooling down, fast-fail 503
    // BEFORE the SUBMITTED→APPROVING transition. APPROVING→SUBMITTED is not a
    // legal transition (state machine §5.1), so entering APPROVING first would
    // leave the request stuck; gating here keeps it non-transient (REQ-DEF-07)
    // while still fast-failing per REQ-SYNC-06. `isHardOpen()` is non-mutating
    // and returns false once cool-down elapses, so a post-cooldown call falls
    // through to the decorator's canPass() to drive the HALF_OPEN probe —
    // gating on raw state would wedge the breaker open forever.
    if (this.breaker.isHardOpen()) {
      await this.recordBreakerFastFail(request.id, actor, correlationId);
      throw new HcmUnavailableError();
    }

    const days = request.daysRequested;
    const delta = -days;
    const preTotal = await this.beginApproving(
      request.id,
      request.employeeId,
      request.locationId,
      actor,
      correlationId,
    );

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
      // Post-commit drift sanity check (REQ-SYNC-04a): only on a real APPROVED
      // commit, never the deferred APPROVING path (no balance was committed
      // there, so there is nothing to drift-check). Fire-and-forget: the queued
      // read must not add latency to this 202 response.
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
        // The breaker OPENed mid-flight (concurrent failures or a lost
        // HALF_OPEN probe) after we had already entered APPROVING. We cannot
        // roll back to SUBMITTED, so we route to APPROVAL_FAILED with the F-01
        // reason rather than leave the request transient (REQ-DEF-07). The
        // 503/`hcm-unavailable` fast-fail is reserved for the entry pre-gate.
        const hcmMeta = {
          request: hcmRequest,
          expected_pre_total: preTotal,
          delta,
          duration_ms: Date.now() - startedAt,
          reason: 'hcm_unreachable',
          outcome: 'failed',
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
        // After APPROVAL_FAILED commits, enqueue a targeted point recon for the
        // two single-balance drift signals — F-05 (HCM 409 insufficient,
        // REQ-SYNC-08) and F-04 (ambiguous adjust, REQ-SYNC-04). Transport /
        // timeout / 5xx are retry+breaker territory, NOT drift, so they are not
        // enqueued. A full batch reconciliation is deliberately NOT triggered
        // for a single-balance event (REQ-SYNC-08).
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

  /** T_local_1: transition to APPROVING, capture the pre-call local total, audit. */
  private async beginApproving(
    requestId: string,
    employeeId: string,
    locationId: string,
    actor: Principal,
    correlationId: string,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.requestRepository.casStatus(
        requestId,
        'SUBMITTED',
        'APPROVING',
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
          action: 'request.approving',
          beforeState: { status: 'SUBMITTED' },
          afterState: { status: 'APPROVING' },
          correlationId,
        },
        manager,
      );
      return balance.totalDays;
    });
  }

  /** T_local_2 success: commit the decrement, transition to APPROVED, audit. */
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
    // R-04 fix (Plan 06): if a batch reconciliation has already absorbed the HCM
    // decrement between our OCC retries, the fresh balance total already equals
    // `preTotal - days`. Re-applying the delta would double-deduct. We detect
    // this by comparing the fresh total to the expected post-commit total; if they
    // match, we skip the total delta and only clear the reservation (reserved -= days).
    const expectedPostTotal = preTotal + -days; // preTotal - days
    try {
      return await withOccRetry(() =>
        this.dataSource.transaction(async (manager) => {
          const balance = await this.requireBalance(employeeId, locationId, manager);
          // Idempotent total application: if reconciliation already absorbed the
          // HCM decrement, skip the total delta — only move reserved_days.
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
          // 202 is the approve status code.
          if (idem) {
            await this.idempotencyService.record(idem.key, idem.hash, 202, response, manager);
          }
          return response;
        }),
      );
    } catch (err) {
      if (err instanceof OccConflictError) {
        // HCM confirmed but the local commit lost the version race past the
        // retry budget. Leave the request APPROVING for the stuck-state sweep
        // (Plan 06); never force a CAS-less write (R-04, TRD §11.1 F-06). Record
        // the confirmed HCM result so the sweep can finish the commit without a
        // second HCM round-trip if it chooses.
        return this.deferCommit(requestId, correlationId, hcmMeta, idem);
      }
      throw err;
    }
  }

  /** T_local_2 failure: release the reservation, transition to APPROVAL_FAILED, audit. */
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
        // 202 is the approve endpoint status code even on APPROVAL_FAILED.
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
    // Record idempotency inside the deferred-commit audit transaction so a client
    // replay returns the same APPROVING response without re-running the saga.
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
      // 202 is the approve endpoint status code.
      if (idem) {
        await this.idempotencyService.record(idem.key, idem.hash, 202, response, manager);
      }
    });
    return response;
  }

  /**
   * Audits a breaker fast-fail at the entry pre-gate. No state transition
   * occurs (the request stays SUBMITTED); this entry exists purely so an
   * operator can answer "why did this approval 503?" (TRD §11.2).
   */
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

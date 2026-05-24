import { randomUUID } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { BalanceNotFoundError } from '../../../common/errors/balance-not-found.error';
import { RequestNotFoundError } from '../../../common/errors/request-not-found.error';
import { OccConflictError } from '../../../common/persistence/occ-conflict.error';
import { withOccRetry } from '../../../common/persistence/with-occ-retry';
import { actorTypeOf, type Principal } from '../../auth/principal';
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

/**
 * Reverse cancellation saga (TRD §3.2 Flow C, §5.2 T-09/10/11). The exact mirror
 * of {@link ApprovalSagaService}: an HCM INCREMENT that restores the days an
 * APPROVED request consumed, run as three phases with the HCM call outside any DB
 * transaction (holding a SQLite write tx across HTTP would block all writers):
 *
 * 1. T-09 — status APPROVED→CANCELLING (status CAS) + capture pre-total + audit.
 * 2. HCM increment (key `<id>:increment`), then the expected-total arithmetic check.
 * 3. T-10 — on success: balance total += days (version CAS, reserved UNCHANGED) +
 *    status→CANCELLED + audit. T-11 on any HCM failure: status→CANCELLATION_FAILED
 *    + audit WITHOUT touching the balance — CANCELLING holds no reservation, so a
 *    `casRelease` here would corrupt the balance (ADR-012, guarded by a failing test).
 *
 * The router ({@link RequestService.cancel}) has already gated state, future-date,
 * and authorization; this saga assumes an APPROVED future-dated request. If the
 * post-HCM commit loses the version race past the retry budget, the request is left
 * CANCELLING for the stuck-state sweep (Plan 06) — never force-committed (R-04).
 */
@Injectable()
export class CancellationSagaService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly balanceRepository: BalanceRepository,
    private readonly requestRepository: RequestRepository,
    private readonly auditService: AuditService,
    @Inject(HCM_ADJUSTER) private readonly hcm: HcmAdjuster,
    private readonly breaker: CircuitBreaker,
    @Inject(POINT_RECONCILIATION_QUEUE) private readonly pointQueue: PointReconciliationQueue,
    // forwardRef: TimeOffModule <-> ReconciliationModule are mutually importing.
    @Inject(forwardRef(() => DriftDetectionService))
    private readonly driftDetection: DriftDetectionService,
  ) {}

  /**
   * Runs the reverse saga for an APPROVED future-dated request (the router has
   * already verified state, future-date, and authorization).
   * @returns the request in its terminal saga state (CANCELLED or
   *   CANCELLATION_FAILED), or CANCELLING if the commit was deferred to the sweep
   * @throws HcmUnavailableError (503) when the breaker is OPEN at entry — the
   *   request stays APPROVED, never entering CANCELLING (REQ-SYNC-06, REQ-DEF-07)
   */
  async execute(requestId: string, actor: Principal): Promise<RequestResponse> {
    const correlationId = randomUUID();
    const request = await this.requestRepository.findById(requestId);
    if (!request) {
      // Defensive only: the router pre-loaded and authorized this request before
      // delegating, so a null here means it vanished between calls (or a misuse).
      throw new RequestNotFoundError();
    }

    // Pre-gate: fast-fail 503 BEFORE the APPROVED→CANCELLING transition.
    // CANCELLING→APPROVED is not a legal back-transition (§5.1), so entering
    // CANCELLING first would wedge the request; gating here keeps it
    // non-transient (REQ-DEF-07) while fast-failing per REQ-SYNC-06.
    if (this.breaker.isHardOpen()) {
      await this.recordBreakerFastFail(request.id, actor, correlationId);
      throw new HcmUnavailableError();
    }

    const days = request.daysRequested;
    const delta = +days; // INCREMENT: restore the consumed days
    const preTotal = await this.beginCancelling(
      request.id,
      request.employeeId,
      request.locationId,
      actor,
      correlationId,
    );

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
      );
      // Post-commit drift sanity check (REQ-SYNC-04a): only on a real CANCELLED
      // commit, never the deferred CANCELLING path. Fire-and-forget.
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
        // The breaker OPENed mid-flight after we entered CANCELLING. We cannot
        // roll back to APPROVED, so we route to CANCELLATION_FAILED with the F-01
        // reason rather than leave the request transient (REQ-DEF-07).
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
          actor,
          new HcmTransportError('HCM breaker opened mid-flight'),
          correlationId,
          hcmMeta,
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
        const failed = await this.fail(request.id, actor, err, correlationId, hcmMeta);
        // After CANCELLATION_FAILED commits, enqueue a targeted point recon for the
        // two single-balance drift signals — F-05 (HCM 409 insufficient) and F-04
        // (ambiguous adjust). An INCREMENT 409-insufficient is unlikely, but the
        // structure mirrors the forward saga (REQ-SYNC-04, REQ-SYNC-08).
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

  /** T-09: transition to CANCELLING, capture the pre-call local total, audit. */
  private async beginCancelling(
    requestId: string,
    employeeId: string,
    locationId: string,
    actor: Principal,
    correlationId: string,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.requestRepository.casStatus(
        requestId,
        'APPROVED',
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
          beforeState: { status: 'APPROVED' },
          afterState: { status: 'CANCELLING' },
          correlationId,
        },
        manager,
      );
      return balance.totalDays;
    });
  }

  /** T-10 success: commit the increment (total += days, reserved UNCHANGED), audit. */
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
  ): Promise<RequestResponse> {
    // R-04 fix (Plan 06): if a batch reconciliation has already absorbed the HCM
    // increment between our OCC retries, the fresh balance total already equals
    // `preTotal + days`. Re-applying the delta would double-add. We detect this
    // by comparing the fresh total to the expected post-commit total; if they
    // match, we skip the total delta (reserved is 0 for CANCELLING, so no change).
    const expectedPostTotal = preTotal + days;
    try {
      return await withOccRetry(() =>
        this.dataSource.transaction(async (manager) => {
          const balance = await this.requireBalance(employeeId, locationId, manager);
          // reservedDelta = 0: CANCELLING holds NO reservation (APPROVED already
          // cleared reserved at T-03), so only total_days moves (ADR-012).
          // R-04: skip total delta if reconciliation already applied it.
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
          return toRequestResponse(updated!);
        }),
      );
    } catch (err) {
      if (err instanceof OccConflictError) {
        // HCM confirmed but the local commit lost the version race past the retry
        // budget. Leave the request CANCELLING for the stuck-state sweep (Plan 06);
        // never force a CAS-less write (R-04).
        return this.deferCommit(requestId, correlationId, hcmMeta);
      }
      throw err;
    }
  }

  /**
   * T-11 failure: transition to CANCELLATION_FAILED, audit. Deliberately does NOT
   * call `casRelease`: CANCELLING holds no reservation, so a release would corrupt
   * the balance — the named copy-paste hazard from ADR-012, guarded by a test.
   */
  private async fail(
    requestId: string,
    actor: Principal,
    error: HcmError,
    correlationId: string,
    hcmMeta: Record<string, unknown>,
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
        return toRequestResponse(updated!);
      }),
    );
  }

  private async deferCommit(
    requestId: string,
    correlationId: string,
    hcmMeta: Record<string, unknown>,
  ): Promise<RequestResponse> {
    await this.dataSource.transaction((manager) =>
      this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'REQUEST',
          entityId: requestId,
          action: 'lifecycle.commit_deferred',
          metadata: { ...hcmMeta, reason: 'occ_exhausted_after_hcm_confirm' },
          correlationId,
        },
        manager,
      ),
    );
    const current = await this.requestRepository.findById(requestId);
    return toRequestResponse(current!);
  }

  /**
   * Audits a breaker fast-fail at the entry pre-gate. No state transition occurs
   * (the request stays APPROVED); this entry exists so an operator can answer
   * "why did this cancel 503?" (TRD §11.2).
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

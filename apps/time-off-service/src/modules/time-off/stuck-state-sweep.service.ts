import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { AuditService } from '../../common/audit/audit.service';
import { BalanceNotFoundError } from '../../common/errors/balance-not-found.error';
import { OccConflictError } from '../../common/persistence/occ-conflict.error';
import { withOccRetry } from '../../common/persistence/with-occ-retry';
import { BalanceRepository } from '../balances/balance.repository';
import { CircuitBreaker } from '../hcm-sync/circuit-breaker';
import { HcmClient } from '../hcm-sync/hcm-client';
import { HcmArithmeticMismatchError, HcmError } from '../hcm-sync/hcm.errors';
import { RequestRepository } from './request.repository';
import type { TimeOffRequest } from '../../database/entities';

/**
 * Resolves time-off requests stuck in the APPROVING or CANCELLING transient saga
 * states (TRD §11.1 F-07, REQ-DEF-11). A crash between saga phase 1 and phase 3
 * leaves rows in those states; this service replays the HCM call with the
 * original idempotency key, then commits or fails the request based on the
 * idempotent HCM response.
 *
 * Arithmetic check for recovery (no persisted pre_total):
 *   Case 1 — HCM has the op, local balance NOT yet committed:
 *     `hcmResponse.newTotalDays === currentLocalTotal + delta`  ← delta applied in HCM, not locally
 *   Case 2 — HCM has the op AND reconciliation already absorbed it:
 *     `hcmResponse.newTotalDays === currentLocalTotal`          ← delta absorbed locally by recon
 *
 * For case 1: commit balance delta normally.
 * For case 2: skip balance delta, only advance status (balance already correct).
 *
 * The sweep calls {@link HcmClient} directly (bypassing {@link ResilientHcmAdjuster})
 * so that case-2 arithmetic mismatches do NOT incorrectly trip the circuit breaker —
 * a case-2 replay is not HCM misbehavior, it is a known-good idempotent response
 * observed after local reconciliation has already applied the delta (ADR decision,
 * Cycle 06).
 */
@Injectable()
export class StuckStateSweepService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly requestRepository: RequestRepository,
    private readonly balanceRepository: BalanceRepository,
    private readonly auditService: AuditService,
    private readonly hcmClient: HcmClient,
    private readonly breaker: CircuitBreaker,
    private readonly configService: ConfigService,
    @InjectPinoLogger(StuckStateSweepService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Finds all requests stuck past the threshold and attempts to resolve each by
   * replaying the HCM call. If the circuit breaker is hard-OPEN the entire sweep
   * is skipped (REQ-DEF-12) — hammering an unavailable HCM is pointless and each
   * individual request will be retried on the next sweep cycle.
   * @returns nothing; outcomes are persisted to audit
   */
  async runSweep(): Promise<void> {
    if (this.breaker.isHardOpen()) {
      this.logger.info(
        { event: 'sweep.skipped', reason: 'hcm_unavailable' },
        'circuit breaker OPEN; stuck-state sweep skipped',
      );
      await this.dataSource.transaction((manager) =>
        this.auditService.record(
          {
            actorType: 'SYSTEM',
            entityType: 'HCM_CALL',
            entityId: 'stuck-state-sweep',
            action: 'sweep.skipped',
            metadata: {
              reason: 'hcm_unavailable',
              breaker: this.breaker.snapshot(),
            },
            correlationId: randomUUID(),
          },
          manager,
        ),
      );
      return;
    }

    const thresholdMs = this.configService.getOrThrow<number>('STUCK_STATE_THRESHOLD_MS');
    const stuckRows = await this.requestRepository.findStuckRequests(thresholdMs);

    if (stuckRows.length === 0) {
      this.logger.debug({ event: 'sweep.no_stuck_rows' }, 'stuck-state sweep: no rows to process');
      return;
    }

    this.logger.info(
      { event: 'sweep.started', count: stuckRows.length },
      `stuck-state sweep: processing ${stuckRows.length} stuck row(s)`,
    );

    for (const request of stuckRows) {
      await this.resolveOne(request);
    }

    this.logger.info(
      { event: 'sweep.finished', count: stuckRows.length },
      `stuck-state sweep: finished processing ${stuckRows.length} row(s)`,
    );
  }

  /**
   * Replays the HCM call for a single stuck request and commits or fails it.
   * @param request the stuck APPROVING or CANCELLING request
   */
  private async resolveOne(request: TimeOffRequest): Promise<void> {
    const correlationId = randomUUID();
    const days = request.daysRequested;

    if (request.status === 'APPROVING') {
      await this.resolveApproving(request, days, correlationId);
    } else {
      await this.resolveCancelling(request, days, correlationId);
    }
  }

  /**
   * Recovery for APPROVING stuck requests. Replays `<id>:decrement` with delta
   * `-days`, then commits APPROVED (case 1) or completes with a balance no-op
   * (case 2) or fails with APPROVAL_FAILED on a real HCM error.
   */
  private async resolveApproving(
    request: TimeOffRequest,
    days: number,
    correlationId: string,
  ): Promise<void> {
    const delta = -days;
    const idempotencyKey = `${request.id}:decrement`;

    // Load the current balance OUTSIDE the transaction (TRD §10.4 commit-boundary
    // discipline: no SQLite write tx held across HTTP). We snapshot `currentLocalTotal`
    // to pass as `expectedPreTotal` — this is our case-1 hypothesis. If HCM returns a
    // total matching `currentLocalTotal` (not `currentLocalTotal + delta`), case 2 is
    // detected in the error handler below.
    const balance = await this.balanceRepository.findByEmployeeAndLocation(
      request.employeeId,
      request.locationId,
    );
    if (!balance) {
      this.logger.error(
        { event: 'sweep.balance_not_found', requestId: request.id, correlationId },
        'balance not found for stuck APPROVING request; skipping',
      );
      return;
    }
    const currentLocalTotal = balance.totalDays;

    const startedAt = Date.now();
    try {
      const verified = await this.hcmClient.adjustBalance({
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta,
        idempotencyKey,
        // We pass currentLocalTotal as the expected pre-total (case-1 hypothesis).
        // If HCM returns currentLocalTotal (case-2: recon already applied the delta),
        // HcmArithmeticMismatchError is thrown with actual === currentLocalTotal and
        // we handle it as case 2 below.
        expectedPreTotal: currentLocalTotal,
        sourceReference: `request:${request.id}`,
      });

      // Case 1: HCM applied the decrement and delta is NOT yet reflected locally.
      // Commit totalDelta=-days, reservedDelta=-days (same as the forward saga T-03).
      await this.commitApproved(
        request,
        days,
        verified.correlationId,
        correlationId,
        'delta_applied',
        verified.newTotalDays,
        Date.now() - startedAt,
      );
    } catch (err) {
      if (err instanceof HcmArithmeticMismatchError) {
        // Check if this is case 2: err.actual === currentLocalTotal means
        // reconciliation already absorbed the HCM decrement into local total.
        if (err.actual === currentLocalTotal) {
          await this.commitApprovedCase2(request, days, correlationId, Date.now() - startedAt);
          return;
        }
        // Real arithmetic mismatch — not case 2. Fail the request.
        await this.failApproving(request, days, err, correlationId, Date.now() - startedAt);
        return;
      }
      if (err instanceof HcmError) {
        await this.failApproving(request, days, err, correlationId, Date.now() - startedAt);
        return;
      }
      // Non-HCM errors (network, OCC on balance load, etc.) propagate up so the
      // scheduler can log them; they do not advance the request state.
      throw err;
    }
  }

  /**
   * Recovery for CANCELLING stuck requests. Replays `<id>:increment` with delta
   * `+days`, then commits CANCELLED (case 1) or completes with a balance no-op
   * (case 2) or fails with CANCELLATION_FAILED on a real HCM error.
   */
  private async resolveCancelling(
    request: TimeOffRequest,
    days: number,
    correlationId: string,
  ): Promise<void> {
    const delta = +days;
    const idempotencyKey = `${request.id}:increment`;

    const balance = await this.balanceRepository.findByEmployeeAndLocation(
      request.employeeId,
      request.locationId,
    );
    if (!balance) {
      this.logger.error(
        { event: 'sweep.balance_not_found', requestId: request.id, correlationId },
        'balance not found for stuck CANCELLING request; skipping',
      );
      return;
    }
    const currentLocalTotal = balance.totalDays;

    const startedAt = Date.now();
    try {
      const verified = await this.hcmClient.adjustBalance({
        employeeId: request.employeeId,
        locationId: request.locationId,
        delta,
        idempotencyKey,
        expectedPreTotal: currentLocalTotal,
        sourceReference: `request:${request.id}`,
      });

      // Case 1: HCM applied the increment and delta is NOT yet reflected locally.
      // Commit totalDelta=+days, reservedDelta=0 (CANCELLING holds no reservation,
      // matching the cancellation saga's T-10 path — ADR-012).
      await this.commitCancelled(
        request,
        days,
        verified.correlationId,
        correlationId,
        'delta_applied',
        verified.newTotalDays,
        Date.now() - startedAt,
      );
    } catch (err) {
      if (err instanceof HcmArithmeticMismatchError) {
        if (err.actual === currentLocalTotal) {
          // Case 2: reconciliation already restored the total. Commit status only.
          await this.commitCancelledCase2(request, correlationId, Date.now() - startedAt);
          return;
        }
        await this.failCancelling(request, err, correlationId, Date.now() - startedAt);
        return;
      }
      if (err instanceof HcmError) {
        await this.failCancelling(request, err, correlationId, Date.now() - startedAt);
        return;
      }
      throw err;
    }
  }

  /** Case 1 commit for APPROVING→APPROVED: balance totalDelta and reservedDelta both −days. */
  private async commitApproved(
    request: TimeOffRequest,
    days: number,
    hcmCorrelationId: string,
    correlationId: string,
    recoveryCase: 'delta_applied',
    newTotalDays: number,
    durationMs: number,
  ): Promise<void> {
    await this.commitWithOcc(request, correlationId, async (manager) => {
      const balance = await this.balanceRepository.findByEmployeeAndLocation(
        request.employeeId,
        request.locationId,
        manager,
      );
      if (!balance) throw new BalanceNotFoundError();

      // totalDelta=-days, reservedDelta=-days: mirrors the normal T-03 commit.
      await this.balanceRepository.casCommit(
        balance.id,
        balance.version,
        -days,
        -days,
        hcmCorrelationId,
        manager,
      );
      await this.requestRepository.casStatus(
        request.id,
        'APPROVING',
        'APPROVED',
        { hcmCorrelationId, decidedAt: new Date() },
        manager,
      );
      await this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'REQUEST',
          entityId: request.id,
          action: 'lifecycle.recovery.committed',
          afterState: { status: 'APPROVED' },
          metadata: {
            idempotencyKey: `${request.id}:decrement`,
            case: recoveryCase,
            hcmCorrelationId,
            newTotalDays,
            durationMs,
          },
          correlationId,
        },
        manager,
      );
    });
  }

  /** Case 2 commit for APPROVING→APPROVED: balance already correct, status only. */
  private async commitApprovedCase2(
    request: TimeOffRequest,
    days: number,
    correlationId: string,
    durationMs: number,
  ): Promise<void> {
    // Case 2: reconciliation already applied the decrement to local total.
    // We still need to release the reservation (reservedDelta=-days) and advance
    // the status, but must NOT apply the total delta again.
    await this.commitWithOcc(request, correlationId, async (manager) => {
      const balance = await this.balanceRepository.findByEmployeeAndLocation(
        request.employeeId,
        request.locationId,
        manager,
      );
      if (!balance) throw new BalanceNotFoundError();

      // totalDelta=0 (recon already applied), reservedDelta=-days (release reservation).
      // We use casRelease for the reservation only, then update status separately.
      await this.balanceRepository.casRelease(balance.id, balance.version, -days, manager);
      await this.requestRepository.casStatus(
        request.id,
        'APPROVING',
        'APPROVED',
        { decidedAt: new Date() },
        manager,
      );
      await this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'REQUEST',
          entityId: request.id,
          action: 'lifecycle.recovery.committed',
          afterState: { status: 'APPROVED' },
          metadata: { idempotencyKey: `${request.id}:decrement`, case: 'reconciled', durationMs },
          correlationId,
        },
        manager,
      );
    });
  }

  /** Case 1 commit for CANCELLING→CANCELLED: totalDelta=+days, reservedDelta=0. */
  private async commitCancelled(
    request: TimeOffRequest,
    days: number,
    hcmCorrelationId: string,
    correlationId: string,
    recoveryCase: 'delta_applied',
    newTotalDays: number,
    durationMs: number,
  ): Promise<void> {
    await this.commitWithOcc(request, correlationId, async (manager) => {
      const balance = await this.balanceRepository.findByEmployeeAndLocation(
        request.employeeId,
        request.locationId,
        manager,
      );
      if (!balance) throw new BalanceNotFoundError();

      // totalDelta=+days, reservedDelta=0: mirrors the normal T-10 commit (ADR-012
      // CANCELLING holds no reservation — the CANCELLING state IS counted in
      // RESERVING_STATUSES for the INV-03 reconciliation invariant, so reservedDays
      // is left unchanged here; the next reconciliation re-asserts the correct sum).
      await this.balanceRepository.casCommit(
        balance.id,
        balance.version,
        +days,
        0,
        hcmCorrelationId,
        manager,
      );
      await this.requestRepository.casStatus(
        request.id,
        'CANCELLING',
        'CANCELLED',
        { hcmCorrelationId, decidedAt: new Date() },
        manager,
      );
      await this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'REQUEST',
          entityId: request.id,
          action: 'lifecycle.recovery.committed',
          afterState: { status: 'CANCELLED' },
          metadata: {
            idempotencyKey: `${request.id}:increment`,
            case: recoveryCase,
            hcmCorrelationId,
            newTotalDays,
            durationMs,
          },
          correlationId,
        },
        manager,
      );
    });
  }

  /** Case 2 commit for CANCELLING→CANCELLED: balance already correct, status only. */
  private async commitCancelledCase2(
    request: TimeOffRequest,
    correlationId: string,
    durationMs: number,
  ): Promise<void> {
    await this.commitWithOcc(request, correlationId, async (manager) => {
      // CANCELLING holds no reservation (casRelease would corrupt balance per ADR-012).
      // casStatus alone is sufficient: the total was already restored by reconciliation.
      await this.requestRepository.casStatus(
        request.id,
        'CANCELLING',
        'CANCELLED',
        { decidedAt: new Date() },
        manager,
      );
      await this.auditService.record(
        {
          actorType: 'SYSTEM',
          entityType: 'REQUEST',
          entityId: request.id,
          action: 'lifecycle.recovery.committed',
          afterState: { status: 'CANCELLED' },
          metadata: { idempotencyKey: `${request.id}:increment`, case: 'reconciled', durationMs },
          correlationId,
        },
        manager,
      );
    });
  }

  /** Fails an APPROVING request: APPROVING→APPROVAL_FAILED, releases reservation. */
  private async failApproving(
    request: TimeOffRequest,
    days: number,
    error: HcmError,
    correlationId: string,
    durationMs: number,
  ): Promise<void> {
    await withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const balance = await this.balanceRepository.findByEmployeeAndLocation(
          request.employeeId,
          request.locationId,
          manager,
        );
        if (!balance) throw new BalanceNotFoundError();

        // Release the reservation (T-04 compensation).
        await this.balanceRepository.casRelease(balance.id, balance.version, -days, manager);
        await this.requestRepository.casStatus(
          request.id,
          'APPROVING',
          'APPROVAL_FAILED',
          { failureReason: error.reason },
          manager,
        );
        await this.auditService.record(
          {
            actorType: 'SYSTEM',
            entityType: 'REQUEST',
            entityId: request.id,
            action: 'lifecycle.recovery.failed',
            afterState: { status: 'APPROVAL_FAILED', failureReason: error.reason },
            metadata: {
              idempotencyKey: `${request.id}:decrement`,
              reason: error.reason,
              durationMs,
            },
            correlationId,
          },
          manager,
        );
      }),
    );
    this.logger.warn(
      {
        event: 'sweep.recovery.failed',
        requestId: request.id,
        reason: error.reason,
        correlationId,
      },
      'stuck APPROVING request recovery failed; transitioned to APPROVAL_FAILED',
    );
  }

  /**
   * Fails a CANCELLING request: CANCELLING→CANCELLATION_FAILED. Deliberately does
   * NOT call `casRelease`: CANCELLING holds no reservation (ADR-012, same as T-11).
   */
  private async failCancelling(
    request: TimeOffRequest,
    error: HcmError,
    correlationId: string,
    durationMs: number,
  ): Promise<void> {
    await withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        await this.requestRepository.casStatus(
          request.id,
          'CANCELLING',
          'CANCELLATION_FAILED',
          { failureReason: error.reason },
          manager,
        );
        await this.auditService.record(
          {
            actorType: 'SYSTEM',
            entityType: 'REQUEST',
            entityId: request.id,
            action: 'lifecycle.recovery.failed',
            afterState: { status: 'CANCELLATION_FAILED', failureReason: error.reason },
            metadata: {
              idempotencyKey: `${request.id}:increment`,
              reason: error.reason,
              durationMs,
            },
            correlationId,
          },
          manager,
        );
      }),
    );
    this.logger.warn(
      {
        event: 'sweep.recovery.failed',
        requestId: request.id,
        reason: error.reason,
        correlationId,
      },
      'stuck CANCELLING request recovery failed; transitioned to CANCELLATION_FAILED',
    );
  }

  /**
   * Wraps the commit body with `withOccRetry`. On OCC exhaustion, records a
   * `lifecycle.commit_deferred` audit entry and leaves the request in its current
   * transient state for the next sweep cycle (R-04, TRD §11.1 F-06).
   */
  private async commitWithOcc(
    request: TimeOffRequest,
    correlationId: string,
    body: (manager: import('typeorm').EntityManager) => Promise<void>,
  ): Promise<void> {
    try {
      await withOccRetry(() => this.dataSource.transaction(body));
      this.logger.info(
        { event: 'sweep.recovery.committed', requestId: request.id, correlationId },
        `stuck ${request.status} request recovery committed`,
      );
    } catch (err) {
      if (err instanceof OccConflictError) {
        // OCC exhausted: leave in current transient state for the next sweep cycle.
        await this.dataSource.transaction((manager) =>
          this.auditService.record(
            {
              actorType: 'SYSTEM',
              entityType: 'REQUEST',
              entityId: request.id,
              action: 'lifecycle.commit_deferred',
              metadata: { reason: 'occ_exhausted_during_sweep', correlationId },
              correlationId,
            },
            manager,
          ),
        );
        this.logger.warn(
          { event: 'sweep.commit_deferred', requestId: request.id, correlationId },
          'OCC exhausted during sweep commit; deferred to next cycle',
        );
        return;
      }
      throw err;
    }
  }
}

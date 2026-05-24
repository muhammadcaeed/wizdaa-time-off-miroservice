import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditService } from '../../common/audit/audit.service';
import { BalanceNotFoundError } from '../../common/errors/balance-not-found.error';
import { ForbiddenError } from '../../common/errors/forbidden.error';
import { InsufficientBalanceError } from '../../common/errors/insufficient-balance.error';
import { RequestNotFoundError } from '../../common/errors/request-not-found.error';
import { withOccRetry } from '../../common/persistence/with-occ-retry';
import { AuthorizationService } from '../auth/authorization.service';
import { actorTypeOf, type Principal } from '../auth/principal';
import { BalanceRepository } from '../balances/balance.repository';
import { InvalidTransitionError } from '../../common/errors/invalid-transition.error';
import { RequestRepository } from './request.repository';
import { CancellationSagaService } from './sagas/cancellation-saga.service';
import { toRequestResponse, type RequestResponse } from './dto/request-response.dto';
import type { SubmitRequestDto } from './dto/submit-request.dto';

/**
 * The result of routing a cancel (ADR-012). `accepted: true` means the request
 * entered the asynchronous reverse saga (the controller answers 202); `false`
 * means a synchronous terminal transition already completed (200).
 */
export interface CancelOutcome {
  accepted: boolean;
  request: RequestResponse;
}

/**
 * Today's date as a `YYYY-MM-DD` string in UTC. `start_date` is stored as a bare
 * date string, and the TRD assumes UTC throughout (§2.2), so a lexical compare of
 * two `YYYY-MM-DD` strings is a correct date compare with no timezone drift.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Submission flow (T-01). The owner is always the authenticated principal. The
 * reservation is local-only: it confirms `available_days >= days_requested` and
 * increments `Balance.reserved_days` under the optimistic version check, inserts
 * the SUBMITTED request, and appends the audit row — all in one transaction
 * wrapped in {@link withOccRetry} so a lost version race retries against fresh
 * state (TRD §9.2, §10.1, REQ-LIFE-01).
 */
@Injectable()
export class RequestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly balanceRepository: BalanceRepository,
    private readonly requestRepository: RequestRepository,
    private readonly auditService: AuditService,
    private readonly authorization: AuthorizationService,
    private readonly cancellationSaga: CancellationSagaService,
  ) {}

  /**
   * Submits a new request for the authenticated employee.
   * @throws BalanceNotFoundError when no balance exists for the pair
   * @throws InsufficientBalanceError (409) when days exceed available, with no state change
   */
  async submit(actor: Principal, dto: SubmitRequestDto): Promise<RequestResponse> {
    const employeeId = actor.sub;
    const requestId = randomUUID();

    return withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const balance = await this.balanceRepository.findByEmployeeAndLocation(
          employeeId,
          dto.location_id,
          manager,
        );
        if (!balance) {
          throw new BalanceNotFoundError();
        }

        const available = balance.totalDays - balance.reservedDays;
        if (dto.days_requested > available) {
          throw new InsufficientBalanceError(available, dto.days_requested);
        }

        // CAS — throws OccConflictError on a lost race; withOccRetry re-reads.
        await this.balanceRepository.casReserve(
          balance.id,
          balance.version,
          dto.days_requested,
          manager,
        );

        await this.requestRepository.insert(
          {
            id: requestId,
            employeeId,
            locationId: dto.location_id,
            startDate: dto.start_date,
            endDate: dto.end_date,
            daysRequested: dto.days_requested,
            status: 'SUBMITTED',
            submittedAt: new Date(),
            reason: dto.reason,
          },
          manager,
        );

        await this.auditService.record(
          {
            actorId: actor.sub,
            actorType: actorTypeOf(actor),
            entityType: 'REQUEST',
            entityId: requestId,
            action: 'request.submitted',
            afterState: { status: 'SUBMITTED', daysRequested: dto.days_requested },
          },
          manager,
        );

        const created = await this.requestRepository.findById(requestId, manager);
        return toRequestResponse(created!);
      }),
    );
  }

  /**
   * Manager/admin rejects a SUBMITTED request (T-07): release the reservation,
   * transition to REJECTED, audit — all in one transaction. No HCM call.
   * @throws RequestNotFoundError (404) when the request does not exist
   * @throws ForbiddenError (403) when the actor is not the owner's manager/admin
   * @throws InvalidTransitionError (409) when the request is not SUBMITTED
   */
  async reject(actor: Principal, requestId: string): Promise<RequestResponse> {
    const request = await this.requestRepository.findById(requestId);
    if (!request) {
      // Hide existence from non-admins (REQ-DEF-10); admins get a true 404.
      throw this.authorization.canSeeExistence(actor)
        ? new RequestNotFoundError()
        : new ForbiddenError();
    }
    await this.authorization.assertCanApprove(actor, request.employeeId);
    const days = request.daysRequested;

    return withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const balance = await this.balanceRepository.findByEmployeeAndLocation(
          request.employeeId,
          request.locationId,
          manager,
        );
        if (!balance) {
          throw new BalanceNotFoundError();
        }
        await this.balanceRepository.casRelease(balance.id, balance.version, -days, manager);
        await this.requestRepository.casStatus(
          requestId,
          'SUBMITTED',
          'REJECTED',
          { decidedBy: actor.sub, decidedAt: new Date() },
          manager,
        );
        await this.auditService.record(
          {
            actorId: actor.sub,
            actorType: actorTypeOf(actor),
            entityType: 'REQUEST',
            entityId: requestId,
            action: 'request.rejected',
            beforeState: { status: 'SUBMITTED' },
            afterState: { status: 'REJECTED' },
          },
          manager,
        );
        const updated = await this.requestRepository.findById(requestId, manager);
        return toRequestResponse(updated!);
      }),
    );
  }

  /**
   * Routes a cancel by the request's current status (ADR-012). The status read is
   * advisory; each branch's status-CAS is the authoritative gate, so a concurrent
   * transition surfaces as a 409 rather than mis-routing. Owner or admin only.
   * @returns a {@link CancelOutcome}: `accepted: true` for the async saga path
   *   (APPROVED future-dated), `false` for a synchronous terminal transition
   * @throws RequestNotFoundError (404) / ForbiddenError (403) per existence-hiding
   * @throws InvalidTransitionError (409) for APPROVING/CANCELLING, past-dated
   *   APPROVED, or any other non-cancellable state
   * @throws HcmUnavailableError (503) when the saga breaker is OPEN (APPROVED path)
   */
  async cancel(actor: Principal, requestId: string): Promise<CancelOutcome> {
    const request = await this.requestRepository.findById(requestId);
    if (!request) {
      // Hide existence from non-admins (REQ-DEF-10); admins get a true 404.
      throw this.authorization.canSeeExistence(actor)
        ? new RequestNotFoundError()
        : new ForbiddenError();
    }
    this.authorization.assertCanCancel(actor, request.employeeId);

    // Correlation id for the two no-HCM paths, mirroring the saga paths so every
    // cancel audit row is traceable (parity with the saga's per-flow id).
    const correlationId = randomUUID();
    switch (request.status) {
      case 'SUBMITTED':
        // T-08, REQ-LIFE-08: release the local reservation, no HCM call.
        return {
          accepted: false,
          request: await this.releaseSubmitted(actor, request, correlationId),
        };
      case 'APPROVAL_FAILED':
        // T-06, REQ-LIFE-13: discard — no HCM, no balance change (the reservation
        // was already released by T-04). Audited as `request.discarded` (ADR-012).
        return {
          accepted: false,
          request: await this.discardFailed(actor, requestId, correlationId),
        };
      case 'APPROVED':
        // T-09: only future-dated cancels run the reverse saga. Equal-to-today
        // counts as past and is not cancellable (TRD §5.3, REQ-LIFE-09).
        if (request.startDate <= todayUtc()) {
          throw new InvalidTransitionError(requestId);
        }
        return { accepted: true, request: await this.cancellationSaga.execute(requestId, actor) };
      default:
        // APPROVING/CANCELLING (R-05, REQ-LIFE-14) and terminal REJECTED/CANCELLED.
        throw new InvalidTransitionError(requestId);
    }
  }

  /** T-08: SUBMITTED→CANCELLED, release the reservation, audit — one tx. */
  private async releaseSubmitted(
    actor: Principal,
    request: { id: string; employeeId: string; locationId: string; daysRequested: number },
    correlationId: string,
  ): Promise<RequestResponse> {
    const days = request.daysRequested;
    return withOccRetry(() =>
      this.dataSource.transaction(async (manager) => {
        const balance = await this.balanceRepository.findByEmployeeAndLocation(
          request.employeeId,
          request.locationId,
          manager,
        );
        if (!balance) {
          throw new BalanceNotFoundError();
        }
        await this.balanceRepository.casRelease(balance.id, balance.version, -days, manager);
        await this.requestRepository.casStatus(
          request.id,
          'SUBMITTED',
          'CANCELLED',
          { decidedBy: actor.sub, decidedAt: new Date() },
          manager,
        );
        await this.auditService.record(
          {
            actorId: actor.sub,
            actorType: actorTypeOf(actor),
            entityType: 'REQUEST',
            entityId: request.id,
            action: 'request.cancelled',
            beforeState: { status: 'SUBMITTED' },
            afterState: { status: 'CANCELLED' },
            correlationId,
          },
          manager,
        );
        const updated = await this.requestRepository.findById(request.id, manager);
        return toRequestResponse(updated!);
      }),
    );
  }

  /** T-06: APPROVAL_FAILED→CANCELLED discard, audited `request.discarded` — one tx, no balance change. */
  private async discardFailed(
    actor: Principal,
    requestId: string,
    correlationId: string,
  ): Promise<RequestResponse> {
    return this.dataSource.transaction(async (manager) => {
      await this.requestRepository.casStatus(
        requestId,
        'APPROVAL_FAILED',
        'CANCELLED',
        { decidedBy: actor.sub, decidedAt: new Date() },
        manager,
      );
      await this.auditService.record(
        {
          actorId: actor.sub,
          actorType: actorTypeOf(actor),
          entityType: 'REQUEST',
          entityId: requestId,
          action: 'request.discarded',
          beforeState: { status: 'APPROVAL_FAILED' },
          afterState: { status: 'CANCELLED' },
          correlationId,
        },
        manager,
      );
      const updated = await this.requestRepository.findById(requestId, manager);
      return toRequestResponse(updated!);
    });
  }
}

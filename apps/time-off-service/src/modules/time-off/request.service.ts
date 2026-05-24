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
import { RequestRepository } from './request.repository';
import { toRequestResponse, type RequestResponse } from './dto/request-response.dto';
import type { SubmitRequestDto } from './dto/submit-request.dto';

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
}

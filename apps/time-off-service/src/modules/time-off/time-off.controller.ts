import { Body, Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';
import { RequestService, type IdempotencyContext } from './request.service';
import { ApprovalSagaService } from './sagas/approval-saga.service';
import { ApprovalRetryService } from './sagas/approval-retry.service';
import { CancellationRetryService } from './sagas/cancellation-retry.service';
import type { RequestResponse } from './dto/request-response.dto';
import { SubmitRequestDto } from './dto/submit-request.dto';

/** Extracts idempotency context set by the interceptor onto the request object. */
function idemFrom(
  req: Request & { idempotencyKey?: string; idempotencyHash?: string },
): IdempotencyContext | undefined {
  if (req.idempotencyKey && req.idempotencyHash) {
    return { key: req.idempotencyKey, hash: req.idempotencyHash };
  }
  return undefined;
}

/** Time-off request lifecycle endpoints (api-contract.md §2). */
@Controller('requests')
export class TimeOffController {
  constructor(
    private readonly requestService: RequestService,
    private readonly approvalSaga: ApprovalSagaService,
    private readonly approvalRetry: ApprovalRetryService,
    private readonly cancellationRetry: CancellationRetryService,
  ) {}

  /**
   * Submits a new request for the authenticated employee (T-01). Returns 201
   * with the SUBMITTED request.
   * @param dto the validated submission payload
   * @param actor the verified caller (owner = `actor.sub`)
   * @param req the Express request (carries idempotency context from the interceptor)
   * @throws InsufficientBalanceError (409) when days exceed available balance
   */
  @Post()
  async submit(
    @Body() dto: SubmitRequestDto,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ): Promise<RequestResponse> {
    return this.requestService.submit(
      actor,
      dto,
      idemFrom(req as Request & { idempotencyKey?: string; idempotencyHash?: string }),
    );
  }

  /**
   * Manager approves a SUBMITTED request (T-02/03/04). Runs the forward saga
   * inline and returns 202 with the request in its resulting state.
   * @param id the request id
   * @param actor the acting manager/admin
   * @param req the Express request (carries idempotency context from the interceptor)
   * @throws RequestNotFoundError (404), ForbiddenError (403), InvalidTransitionError (409)
   */
  @Post(':id/approve')
  @Roles('MANAGER', 'ADMIN')
  @HttpCode(202)
  async approve(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ): Promise<RequestResponse> {
    return this.approvalSaga.execute(
      id,
      actor,
      idemFrom(req as Request & { idempotencyKey?: string; idempotencyHash?: string }),
    );
  }

  /**
   * Manager/admin rejects a SUBMITTED request (T-07). Synchronous, no HCM call;
   * returns 200 with the REJECTED request.
   * @param req the Express request (carries idempotency context from the interceptor)
   * @throws RequestNotFoundError (404), ForbiddenError (403), InvalidTransitionError (409)
   */
  @Post(':id/reject')
  @Roles('MANAGER', 'ADMIN')
  @HttpCode(200)
  async reject(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ): Promise<RequestResponse> {
    return this.requestService.reject(
      actor,
      id,
      idemFrom(req as Request & { idempotencyKey?: string; idempotencyHash?: string }),
    );
  }

  /**
   * Owner or admin cancels a request (T-06/08/09). The {@link RequestService}
   * routes by state (ADR-012); no `@Roles` guard here because a plain EMPLOYEE
   * owner may cancel — authorization lives in the service. The status code is
   * variable: 202 when the reverse saga was accepted (APPROVED future-dated),
   * 200 for a synchronous terminal transition (SUBMITTED release, APPROVAL_FAILED
   * discard). `@Res({ passthrough: true })` lets us set the status while NestJS
   * still serializes the returned body (NestJS docs, controllers#library-specific-approach).
   * @param id the request id
   * @param actor the verified caller (owner or admin)
   * @throws ForbiddenError (403) when the actor is neither owner nor admin
   * @throws RequestNotFoundError (404) when an admin targets a missing request
   * @throws InvalidTransitionError (409) for a non-cancellable or past-dated state
   * @throws HcmUnavailableError (503) when the saga breaker is OPEN
   */
  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ): Promise<RequestResponse> {
    const outcome = await this.requestService.cancel(
      actor,
      id,
      idemFrom(req as Request & { idempotencyKey?: string; idempotencyHash?: string }),
    );
    res.status(outcome.accepted ? 202 : 200);
    return outcome.request;
  }

  /**
   * Admin retries a stuck APPROVAL_FAILED request (T-05). Runs the retry saga
   * inline and returns 202 with the request in its resulting state.
   * @param id the request id
   * @param actor the acting admin
   * @throws RequestNotFoundError (404), InvalidTransitionError (409),
   *   InsufficientBalanceError (409), HcmUnavailableError (503)
   * @req REQ-LIFE-06
   */
  @Post(':id/approval-retries')
  @Roles('ADMIN')
  @HttpCode(202)
  async retryApproval(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ): Promise<RequestResponse> {
    return this.approvalRetry.retry(
      id,
      actor,
      idemFrom(req as Request & { idempotencyKey?: string; idempotencyHash?: string }),
    );
  }

  /**
   * Admin retries a stuck CANCELLATION_FAILED request (T-12). Runs the retry saga
   * inline and returns 202 with the request in its resulting state.
   * @param id the request id
   * @param actor the acting admin
   * @throws RequestNotFoundError (404), InvalidTransitionError (409),
   *   HcmUnavailableError (503)
   * @req REQ-LIFE-12
   */
  @Post(':id/cancellation-retries')
  @Roles('ADMIN')
  @HttpCode(202)
  async retryCancellation(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
    @Req() req: Request,
  ): Promise<RequestResponse> {
    return this.cancellationRetry.retry(
      id,
      actor,
      idemFrom(req as Request & { idempotencyKey?: string; idempotencyHash?: string }),
    );
  }
}

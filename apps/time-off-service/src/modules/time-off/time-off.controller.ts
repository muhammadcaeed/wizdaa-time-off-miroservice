import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';
import { RequestService } from './request.service';
import { ApprovalSagaService } from './sagas/approval-saga.service';
import type { RequestResponse } from './dto/request-response.dto';
import { SubmitRequestDto } from './dto/submit-request.dto';

/** Time-off request lifecycle endpoints (api-contract.md §2). */
@Controller('requests')
export class TimeOffController {
  constructor(
    private readonly requestService: RequestService,
    private readonly approvalSaga: ApprovalSagaService,
  ) {}

  /**
   * Submits a new request for the authenticated employee (T-01). Returns 201
   * with the SUBMITTED request.
   * @param dto the validated submission payload
   * @param actor the verified caller (owner = `actor.sub`)
   * @throws InsufficientBalanceError (409) when days exceed available balance
   */
  @Post()
  async submit(
    @Body() dto: SubmitRequestDto,
    @CurrentUser() actor: Principal,
  ): Promise<RequestResponse> {
    return this.requestService.submit(actor, dto);
  }

  /**
   * Manager approves a SUBMITTED request (T-02/03/04). Runs the forward saga
   * inline and returns 202 with the request in its resulting state.
   * @param id the request id
   * @param actor the acting manager/admin
   * @throws RequestNotFoundError (404), ForbiddenError (403), InvalidTransitionError (409)
   */
  @Post(':id/approve')
  @Roles('MANAGER', 'ADMIN')
  @HttpCode(202)
  async approve(
    @Param('id') id: string,
    @CurrentUser() actor: Principal,
  ): Promise<RequestResponse> {
    return this.approvalSaga.execute(id, actor);
  }

  /**
   * Manager/admin rejects a SUBMITTED request (T-07). Synchronous, no HCM call;
   * returns 200 with the REJECTED request.
   * @throws RequestNotFoundError (404), ForbiddenError (403), InvalidTransitionError (409)
   */
  @Post(':id/reject')
  @Roles('MANAGER', 'ADMIN')
  @HttpCode(200)
  async reject(@Param('id') id: string, @CurrentUser() actor: Principal): Promise<RequestResponse> {
    return this.requestService.reject(actor, id);
  }
}

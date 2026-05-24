import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '../auth/authorization.service';
import type { Principal } from '../auth/principal';
import { BalanceRepository } from './balance.repository';
import { toBalanceResponse, type BalanceResponse } from './dto/balance-response.dto';

/**
 * Read-side balance access. Serves from the local cache only — no HCM call
 * (REQ-BAL-04) — and computes `available_days = total_days - reserved_days`.
 */
@Injectable()
export class BalancesService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly balanceRepository: BalanceRepository,
  ) {}

  /**
   * Returns all balances for an employee after an authorization check.
   * @throws ForbiddenError when the actor may not read this employee (REQ-BAL-03)
   */
  async getEmployeeBalances(actor: Principal, employeeId: string): Promise<BalanceResponse> {
    await this.authorization.assertCanReadBalance(actor, employeeId);
    const balances = await this.balanceRepository.findByEmployeeId(employeeId);
    return toBalanceResponse(employeeId, balances);
  }
}

import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { BalancesService } from './balances.service';
import type { BalanceResponse } from './dto/balance-response.dto';

/** Balance read endpoint (api-contract.md §2). */
@Controller('balances')
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  /**
   * Reads an employee's balances (one per location), with computed
   * `available_days` and `last_hcm_sync_at` (REQ-BAL-01, REQ-BAL-05).
   * @param employeeId the target employee
   * @param actor the verified caller (authorization is enforced in the service)
   * @returns the employee's balances
   * @throws ForbiddenError when the caller may not read this employee
   */
  @Get('employees/:employee_id')
  async getEmployeeBalances(
    @Param('employee_id') employeeId: string,
    @CurrentUser() actor: Principal,
  ): Promise<BalanceResponse> {
    return this.balancesService.getEmployeeBalances(actor, employeeId);
  }
}

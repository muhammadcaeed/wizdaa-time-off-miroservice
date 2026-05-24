import { Injectable } from '@nestjs/common';
import { ForbiddenError } from '../../common/errors/forbidden.error';
import { EmployeeRepository } from './employee.repository';
import type { Principal } from './principal';

/**
 * Resource-level RBAC (api-contract.md §3, TRD §13.1). Decisions load the target
 * employee before evaluating and throw {@link ForbiddenError} both when the actor
 * is not permitted and when the target does not exist — the two are
 * indistinguishable to the caller, preventing enumeration (REQ-DEF-10).
 *
 * Lives in the service layer rather than a guard: handlers already load the
 * target inside their repository/transaction wiring, so a pre-controller guard
 * would re-load it redundantly.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly employeeRepository: EmployeeRepository) {}

  private has(actor: Principal, role: Principal['roles'][number]): boolean {
    return actor.roles.includes(role);
  }

  /**
   * Whether the actor is allowed to learn that a resource does not exist (404)
   * versus having its absence hidden behind a 403. Only ADMINs, who can see all
   * resources anyway, get a distinguishable 404; everyone else is denied
   * identically whether the resource is missing or merely off-limits, so the
   * response can't be used to enumerate ids (REQ-DEF-10).
   */
  canSeeExistence(actor: Principal): boolean {
    return this.has(actor, 'ADMIN');
  }

  /**
   * Asserts the actor may read `targetEmployeeId`'s balances: own, a direct
   * report (MANAGER), or anyone (ADMIN).
   * @throws ForbiddenError when not permitted or the target is unknown
   */
  async assertCanReadBalance(actor: Principal, targetEmployeeId: string): Promise<void> {
    if (this.has(actor, 'ADMIN') || actor.sub === targetEmployeeId) {
      return;
    }
    if (this.has(actor, 'MANAGER') && (await this.isDirectReport(targetEmployeeId, actor.sub))) {
      return;
    }
    throw new ForbiddenError();
  }

  /**
   * Asserts the actor may approve/reject a request owned by `ownerEmployeeId`:
   * the owner's manager (MANAGER) or an ADMIN.
   * @throws ForbiddenError when not permitted or the owner is unknown
   */
  async assertCanApprove(actor: Principal, ownerEmployeeId: string): Promise<void> {
    if (this.has(actor, 'ADMIN')) {
      return;
    }
    if (this.has(actor, 'MANAGER') && (await this.isDirectReport(ownerEmployeeId, actor.sub))) {
      return;
    }
    throw new ForbiddenError();
  }

  /**
   * Asserts the actor may cancel a request owned by `ownerEmployeeId`: the owner
   * themselves or an ADMIN. Unlike {@link assertCanApprove}, a MANAGER does NOT
   * get cancel — cancellation is the owner's prerogative or an admin correction
   * (Plan 05, api-contract.md §3).
   * @throws ForbiddenError when not permitted
   */
  assertCanCancel(actor: Principal, ownerEmployeeId: string): void {
    if (this.has(actor, 'ADMIN') || actor.sub === ownerEmployeeId) {
      return;
    }
    throw new ForbiddenError();
  }

  private async isDirectReport(employeeId: string, managerId: string): Promise<boolean> {
    const employee = await this.employeeRepository.findById(employeeId);
    return employee?.managerId === managerId;
  }
}

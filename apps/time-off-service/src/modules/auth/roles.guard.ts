import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../../common/errors/forbidden.error';
import type { AuthedRequest } from './jwt-auth.guard';
import type { Role } from './principal';
import { ROLES_KEY } from './roles.decorator';

/**
 * Coarse role gate. Reads `@Roles(...)` metadata and admits the caller when its
 * roles intersect the required set; routes without the decorator are open to any
 * authenticated principal. Finer resource checks live in
 * {@link AuthorizationService}. Denials throw {@link ForbiddenError} (403).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const roles = req.principal?.roles ?? [];
    if (!required.some((r) => roles.includes(r))) {
      throw new ForbiddenError();
    }
    return true;
  }
}

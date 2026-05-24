import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './jwt-auth.guard';
import type { Principal } from './principal';

/**
 * Injects the verified {@link Principal} attached by {@link JwtAuthGuard}.
 * Present on every authenticated route (the global guard runs first).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.principal) {
      throw new Error('CurrentUser used on a route without the JwtAuthGuard');
    }
    return req.principal;
  },
);

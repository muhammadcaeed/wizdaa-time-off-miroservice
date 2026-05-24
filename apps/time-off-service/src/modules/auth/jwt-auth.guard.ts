import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { Principal } from './principal';
import { TokenService } from './token.service';

/** Request augmented with the verified principal. */
export interface AuthedRequest extends Request {
  principal?: Principal;
}

/**
 * Global authentication guard (ADR-003). Extracts the `Authorization: Bearer`
 * token, verifies it via {@link TokenService}, and attaches the {@link Principal}
 * to the request. Missing or invalid tokens yield 401. Authorization (role and
 * resource checks) is handled downstream by guards/services, not here.
 *
 * Routes decorated with `@Public()` are skipped entirely; the token is not
 * required and `req.principal` will be undefined.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    try {
      req.principal = this.tokenService.verify(header.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('Invalid bearer token');
    }
    return true;
  }
}

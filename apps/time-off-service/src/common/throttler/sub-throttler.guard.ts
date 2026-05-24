import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest } from '../../modules/auth/jwt-auth.guard';

/**
 * Custom throttler guard that uses the JWT subject (`req.principal.sub`) as the
 * tracking key for authenticated requests. Falls back to the remote IP for public
 * endpoints (e.g. health) where no principal is attached.
 *
 * Registered as APP_GUARD after JwtAuthGuard so `req.principal` is already set
 * when this guard evaluates. Routes decorated with `@SkipThrottle()` are exempt.
 */
@Injectable()
export class SubThrottlerGuard extends ThrottlerGuard {
  /**
   * Returns the JWT subject when a principal is available (authenticated
   * endpoints), otherwise falls back to the client IP (public endpoints).
   *
   * @param req - incoming HTTP request
   * @returns tracking key string
   */
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const authedReq = req as unknown as AuthedRequest;
    const sub = authedReq.principal?.sub;
    // Fall back to IP for unauthenticated / public routes.
    return Promise.resolve(sub ?? authedReq.ip ?? 'unknown');
  }
}

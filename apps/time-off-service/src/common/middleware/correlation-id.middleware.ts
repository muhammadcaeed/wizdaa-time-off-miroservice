import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { correlationStore } from '../context/correlation.context';

/**
 * Echoes the correlation ID — assigned by pino-http's `genReqId` — back to the
 * caller as the `x-correlation-id` response header.
 *
 * ## Ordering contract
 *
 * `nestjs-pino`'s `LoggerModule` registers `pino-http` as a middleware during
 * the module import phase, which runs *before* `AppModule.configure()`. By the
 * time this middleware executes, `req.id` is already set by `genReqId`:
 *   - to the incoming `x-correlation-id` header value if present, or
 *   - to a fresh `randomUUID()` otherwise.
 *
 * This middleware therefore has a single responsibility: copy `req.id` to the
 * response header so clients can correlate their logs with the service's logs.
 * It does NOT generate or mutate the ID — `genReqId` owns that.
 *
 * @req REQ-LOG-01
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  /**
   * Copies the pino-assigned request ID to the `x-correlation-id` response header.
   *
   * @param req - Express request; `req.id` is set by pino-http's `genReqId`
   * @param res - Express response
   * @param next - Next middleware callback
   */
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    // req.id is set by pino-http before this middleware runs (see ordering note above)
    const id = (req as unknown as { id?: string }).id ?? '';
    res.setHeader('x-correlation-id', id);
    // Run the rest of the request chain inside the correlation store so
    // downstream code (HCM client) can read the ID without an HTTP reference.
    correlationStore.run({ correlationId: id }, () => next());
  }
}

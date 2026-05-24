import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { CallLogService } from '../services/call-log.service';

/** Control-plane prefix whose calls are excluded from the log (mock-hcm.md §3.6). */
const CONTROL_PLANE_PREFIX = '/mock/control';

/**
 * Records every HCM-surface request to the {@link CallLogService} so chaos and
 * contract tests can assert what the client sent (mock-hcm.md §3.6). Control-
 * plane calls are skipped to keep the log to the HCM contract surface only.
 *
 * Records on the response's `finish`/`close` events rather than in the rxjs
 * pipe so the recorded status is the FINAL one — after Nest's exception filter
 * has mapped a thrown error to its HTTP status (e.g. 503 for the `down`
 * scenario). When the socket is destroyed before the body finishes (the
 * `network-failure` scenario), `close` fires without `finish`, so we record
 * `status: 0` with `transport_error: true`, preserving the Idempotency-Key
 * that was sent on the failed attempt.
 */
@Injectable()
export class CallLogInterceptor implements NestInterceptor {
  constructor(private readonly callLog: CallLogService) {}

  /**
   * Wraps the handler, recording the call once the response stream settles.
   * @param context the execution context
   * @param next the downstream handler
   * @returns the unchanged handler stream
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const path = req.originalUrl ?? req.url;

    if (path.startsWith(CONTROL_PLANE_PREFIX)) {
      return next.handle();
    }

    const idempotencyKey = req.headers['idempotency-key'];
    const recordedKey = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;

    let recorded = false;
    const record = (finished: boolean): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      this.callLog.record({
        method: req.method,
        path,
        body: req.body as unknown,
        headers: recordedKey !== undefined ? { 'idempotency-key': recordedKey } : {},
        status: finished ? res.statusCode : 0,
        ...(finished ? {} : { transport_error: true }),
        timestamp: new Date().toISOString(),
      });
    };
    // `finish` => body fully sent (after the exception filter set the status).
    // `close` without `finish` => socket destroyed mid-response.
    res.once('finish', () => record(true));
    res.once('close', () => record(res.writableFinished));

    return next.handle();
  }
}

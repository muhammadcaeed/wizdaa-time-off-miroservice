import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { IdempotencyConflictError } from '../../common/errors/idempotency-conflict.error';
import { IdempotencyKeyInvalidError } from '../../common/errors/idempotency-key-invalid.error';
import { IdempotencyService } from './idempotency.service';

/** UUID v4 pattern (case-insensitive). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Computes the canonical SHA-256 fingerprint of the request:
 * SHA-256(`<METHOD><URL><sorted-JSON-body>`).
 *
 * Bodies are key-sorted so `{"b":1,"a":2}` and `{"a":2,"b":1}` produce the
 * same hash. Endpoints with no body (approve, reject, cancel, retries) produce
 * a fingerprint for `{}` — deterministic for empty/undefined bodies.
 */
export function computeRequestHash(method: string, url: string, body: unknown): string {
  const canonicalBody = sortedJsonStringify(body ?? {});
  return createHash('sha256').update(`${method}${url}${canonicalBody}`).digest('hex');
}

function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, (v as Record<string, unknown>)[k]]),
      );
    }
    return v;
  });
}

/**
 * Idempotency interceptor for POST endpoints (api-contract.md §6).
 *
 * Behaviour:
 * - If no `Idempotency-Key` header: pass through transparently (no-op).
 * - If header present but not a UUID v4: throw {@link IdempotencyKeyInvalidError} (400).
 * - If key seen before and NOT expired:
 *   - Same request hash → replay stored response immediately, do NOT re-execute.
 *   - Different hash → throw {@link IdempotencyConflictError} (409).
 * - If key is new: set `req.idempotencyKey` + `req.idempotencyHash` on the
 *   Express Request so each service method can write the record inside its
 *   DB transaction.
 *
 * The interceptor deliberately does NOT write the record itself — writing inside
 * the operation's transaction is the only safe approach (avoids phantom records
 * for failed operations).
 *
 * Only operates on POST methods; GET/PATCH/DELETE pass through unchanged.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotencyService: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { idempotencyKey?: string; idempotencyHash?: string }>();
    const res = http.getResponse<Response>();

    // Only POST requests participate in idempotency.
    if (req.method !== 'POST') {
      return next.handle();
    }

    const rawKey = req.headers['idempotency-key'];
    if (!rawKey) {
      return next.handle();
    }

    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!UUID_PATTERN.test(key)) {
      throw new IdempotencyKeyInvalidError();
    }

    const hash = computeRequestHash(req.method, req.url, req.body);

    // Async check: we must return a Promise-wrapped Observable.
    return new Observable((subscriber) => {
      this.idempotencyService
        .check(key)
        .then((stored) => {
          if (stored !== null) {
            if (stored.requestHash !== hash) {
              // Same key, different payload — client programming error.
              subscriber.error(new IdempotencyConflictError());
              return;
            }
            // Replay: set the original status code and emit the stored body.
            res.status(stored.responseStatus);
            subscriber.next(stored.responseBody);
            subscriber.complete();
            return;
          }

          // New key: thread it into the request so service methods can write
          // the record inside their transaction.
          req.idempotencyKey = key;
          req.idempotencyHash = hash;

          // Record is written by the service layer inside its transaction.
          next.handle().subscribe(subscriber);
        })
        .catch((err: unknown) => subscriber.error(err));
    });
  }
}

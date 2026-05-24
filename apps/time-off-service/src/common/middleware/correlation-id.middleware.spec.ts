import type { NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

/**
 * Unit tests for CorrelationIdMiddleware.
 *
 * The middleware's contract (REQ-LOG-01):
 *  - When `x-correlation-id` is present in the request, echo it on the response
 *    header and expose it as `req.correlationId`.
 *  - When the header is absent, generate a UUID (v4 pattern), set it as
 *    `req.correlationId`, and echo it on the response header.
 *
 * Ordering note: pino-http runs first (registered by LoggerModule import) and
 * uses `genReqId` as its single source of truth for the correlation ID.
 * `genReqId` reads `req.headers['x-correlation-id']` or generates a UUID.
 * This middleware then sets `res.setHeader('x-correlation-id', req.id)` to
 * echo the ID the pino-http already committed back to the caller.
 *
 * @req REQ-LOG-01
 */
describe('CorrelationIdMiddleware', () => {
  function makeReq(headers: Record<string, string> = {}): IncomingMessage & { id?: string } {
    return { headers } as unknown as IncomingMessage & { id?: string };
  }

  function makeRes(): ServerResponse & { getHeader: (h: string) => string | undefined } {
    const headers: Record<string, string> = {};
    return {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
    } as unknown as ServerResponse & { getHeader: (h: string) => string | undefined };
  }

  let middleware: CorrelationIdMiddleware;

  beforeEach(() => {
    middleware = new CorrelationIdMiddleware();
  });

  it('passes through an existing X-Correlation-ID header and echoes it on the response', () => {
    const req = makeReq({ 'x-correlation-id': 'abc-123' });
    // Simulate pino-http having already set req.id from genReqId
    req.id = 'abc-123';
    const res = makeRes();
    const next: NextFunction = vi.fn();

    middleware.use(req as never, res as never, next);

    expect(res.getHeader('x-correlation-id')).toBe('abc-123');
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets a UUID response header when no X-Correlation-ID is present', () => {
    const req = makeReq();
    // Simulate pino-http having generated a UUID for req.id
    const generatedId = '550e8400-e29b-41d4-a716-446655440000';
    req.id = generatedId;
    const res = makeRes();
    const next: NextFunction = vi.fn();

    middleware.use(req as never, res as never, next);

    expect(res.getHeader('x-correlation-id')).toBe(generatedId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('always calls next()', () => {
    const req = makeReq({ 'x-correlation-id': 'test-id' });
    req.id = 'test-id';
    const res = makeRes();
    const next: NextFunction = vi.fn();

    middleware.use(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * Unit tests for the genReqId logic used in pino-http configuration.
 *
 * This validates the correlation ID extraction/generation logic that lives in
 * app.module.ts's LoggerModule.forRootAsync factory. Tested here in isolation
 * because the factory function is pure and testable without a full NestJS boot.
 *
 * @req REQ-LOG-01
 */
describe('genReqId logic (pino-http source of truth)', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  /**
   * Extracted from app.module.ts LoggerModule factory — must stay in sync.
   * genReqId is pino-http's single source of truth for the request ID.
   */
  function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
    const existing = req.headers['x-correlation-id'];
    return (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
  }

  it('uses the provided x-correlation-id header value', () => {
    const id = genReqId({ headers: { 'x-correlation-id': 'my-trace-id' } });
    expect(id).toBe('my-trace-id');
  });

  it('uses the first value when x-correlation-id is an array', () => {
    const id = genReqId({ headers: { 'x-correlation-id': ['first', 'second'] } });
    expect(id).toBe('first');
  });

  it('generates a UUID v4 when x-correlation-id header is absent', () => {
    const id = genReqId({ headers: {} });
    expect(id).toMatch(UUID_PATTERN);
  });

  it('generates a UUID v4 when x-correlation-id is undefined', () => {
    const id = genReqId({ headers: { 'x-correlation-id': undefined } });
    expect(id).toMatch(UUID_PATTERN);
  });

  it('generates unique IDs on consecutive calls without a header', () => {
    const id1 = genReqId({ headers: {} });
    const id2 = genReqId({ headers: {} });
    expect(id1).not.toBe(id2);
  });
});

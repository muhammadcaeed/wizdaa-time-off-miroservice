import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import { DomainError } from './domain-error';

// ---------------------------------------------------------------------------
// Minimal concrete DomainError for tests
// ---------------------------------------------------------------------------
class TestDomainError extends DomainError {
  readonly httpStatus = 409;
  readonly typeUri = 'https://api.wizdaa.dev/errors/test-error';

  constructor(message = 'test domain error') {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helpers to build a mock ArgumentsHost
// ---------------------------------------------------------------------------
function buildHost(opts: { correlationId?: string; url?: string }): {
  host: ArgumentsHost;
  setHeader: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  statusFn: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  // The filter chains response.status(s).setHeader(...).json(body).
  // setHeader must return the same chainable object so json() is callable.
  const chainable: Record<string, ReturnType<typeof vi.fn>> = {};
  const setHeader = vi.fn().mockReturnValue(chainable);
  chainable.json = json;
  chainable.setHeader = setHeader;

  // status() returns the chainable object.
  const statusFn = vi.fn().mockReturnValue(chainable);

  const response = {
    status: statusFn,
    setHeader,
  };

  const headers: Record<string, string> = {};
  if (opts.correlationId) {
    headers['x-correlation-id'] = opts.correlationId;
  }

  const request = {
    url: opts.url ?? '/requests',
    headers,
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, setHeader, json, statusFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * @req REQ-ERR-01
 * @req REQ-ERR-02
 * @req REQ-ERR-03
 * @req REQ-ERR-04
 * @req REQ-ERR-05
 */
describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
  });

  // -------------------------------------------------------------------------
  // Case 1: DomainError → correct RFC 7807 shape + Content-Type header
  // -------------------------------------------------------------------------
  describe('DomainError', () => {
    it('emits correct RFC 7807 shape', () => {
      const { host, json, statusFn } = buildHost({ url: '/requests' });
      filter.catch(new TestDomainError('domain failure'), host);

      expect(statusFn).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(body.type).toBe('https://api.wizdaa.dev/errors/test-error');
      expect(body.title).toBe('TestDomainError');
      expect(body.status).toBe(409);
      expect(body.detail).toBe('domain failure');
      expect(body.instance).toBe('/requests');
      expect(typeof body.timestamp).toBe('string');
    });

    it('sets Content-Type: application/problem+json', () => {
      const { host, setHeader } = buildHost({});
      filter.catch(new TestDomainError(), host);
      // setHeader is called on the chainable object returned by status()
      expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
    });

    // -----------------------------------------------------------------------
    // Case 2: correlation_id present
    // -----------------------------------------------------------------------
    it('includes correlation_id when x-correlation-id header is set', () => {
      const { host, json } = buildHost({ correlationId: 'corr-abc' });
      filter.catch(new TestDomainError(), host);

      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(body.correlation_id).toBe('corr-abc');
    });

    // -----------------------------------------------------------------------
    // Case 3: no correlation_id field when header absent
    // -----------------------------------------------------------------------
    it('omits correlation_id when x-correlation-id header is absent', () => {
      const { host, json } = buildHost({});
      filter.catch(new TestDomainError(), host);

      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(body, 'correlation_id')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: BadRequestException → 400 with errors[] array
  // -------------------------------------------------------------------------
  describe('BadRequestException', () => {
    it('emits 400 with errors[] from message array', () => {
      const { host, json, statusFn } = buildHost({ url: '/requests' });
      const ex = new BadRequestException({
        message: [
          'days_requested must be a positive number',
          'start_date must be a valid ISO 8601 date string',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });

      filter.catch(ex, host);

      expect(statusFn).toHaveBeenCalledWith(400);
      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(body.type).toBe('https://api.wizdaa.dev/errors/validation-error');
      expect(body.title).toBe('ValidationError');
      expect(body.status).toBe(400);
      expect(body.detail).toBe('Request validation failed.');
      expect(body.instance).toBe('/requests');

      const errors = body.errors as Array<{ field: string; message: string }>;
      expect(errors).toHaveLength(2);
      expect(errors[0].field).toBe('days_requested');
      expect(errors[0].message).toContain('must be a positive number');
      expect(errors[1].field).toBe('start_date');
    });

    it('handles plain string message gracefully', () => {
      const { host, json } = buildHost({});
      // NestJS wraps a plain string into { message: 'simple string message', ... }
      // parseValidationMessages treats the first word as the field name.
      const ex = new BadRequestException('simple string message');

      filter.catch(ex, host);

      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(body.type).toBe('https://api.wizdaa.dev/errors/validation-error');
      const errors = body.errors as Array<{ field: string; message: string }>;
      expect(errors).toHaveLength(1);
      // First word becomes the field; remainder is the message text.
      expect(errors[0].field).toBe('simple');
      expect(errors[0].message).toBe('string message');
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: ThrottlerException (no package installed – matched by class name)
  // -------------------------------------------------------------------------
  describe('ThrottlerException (simulated)', () => {
    it('emits 429 with rate-limited type URI', () => {
      const { host, json, statusFn } = buildHost({ url: '/requests' });

      // Simulate a ThrottlerException by crafting an HttpException with status 429
      // and the constructor name expected by the filter.
      class ThrottlerException extends HttpException {
        constructor() {
          super('ThrottlerException', HttpStatus.TOO_MANY_REQUESTS);
          // Force the name so the instanceof check matches what the filter uses
          Object.defineProperty(this, 'name', { value: 'ThrottlerException' });
        }
      }
      Object.defineProperty(ThrottlerException, 'name', { value: 'ThrottlerException' });

      filter.catch(new ThrottlerException(), host);

      expect(statusFn).toHaveBeenCalledWith(429);
      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(body.type).toBe('https://api.wizdaa.dev/errors/rate-limited');
      expect(body.title).toBe('TooManyRequests');
      expect(body.status).toBe(429);
      expect(body.detail).toBe('Rate limit exceeded. Please retry after a moment.');
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: Generic HttpException fallback (e.g. NotFoundException)
  // -------------------------------------------------------------------------
  describe('Generic HttpException fallback', () => {
    it('emits generic RFC 7807 envelope for NotFoundException (404)', () => {
      const { host, json, statusFn } = buildHost({ url: '/requests/99' });
      filter.catch(new NotFoundException('Resource not found'), host);

      expect(statusFn).toHaveBeenCalledWith(404);
      const body = json.mock.calls[0][0] as Record<string, unknown>;
      expect(body.type).toBe('https://api.wizdaa.dev/errors/http-error');
      expect(body.status).toBe(404);
      expect(typeof body.detail).toBe('string');
      expect(body.instance).toBe('/requests/99');
    });
  });
});

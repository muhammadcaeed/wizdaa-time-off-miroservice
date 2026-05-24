import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpException,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error';

// ---------------------------------------------------------------------------
// Stable type URIs (REQ-ERR-04, REQ-ERR-05)
// ---------------------------------------------------------------------------
const VALIDATION_ERROR_TYPE = '/errors/validation-error';
const RATE_LIMIT_TYPE = '/errors/rate-limited';
const HTTP_ERROR_TYPE = '/errors/http-error';

/**
 * Represents a single field-level validation failure emitted in the `errors[]`
 * array of a 400 Problem Details response.
 */
interface ValidationFieldError {
  field: string;
  message: string;
}

/**
 * Parses the `message` payload produced by class-validator/ValidationPipe into
 * an array of `{ field, message }` objects.
 *
 * class-validator emits messages in the form `"fieldName constraint text"`.
 * The special `"property X should not exist"` whitelist message has its field
 * at position 1 (not 0), so we handle both shapes.
 *
 * @param raw - The value of `response.message` from the exception.
 * @returns Parsed field errors, falling back to `{ field: 'unknown' }` for
 *          unrecognised shapes.
 */
function parseValidationMessages(raw: unknown): ValidationFieldError[] {
  const messages = Array.isArray(raw) ? (raw as unknown[]) : [raw];

  return messages.map((item): ValidationFieldError => {
    if (typeof item !== 'string') {
      return { field: 'unknown', message: String(item) };
    }

    // Whitelist violation: "property <field> should not exist"
    const whitelistMatch = /^property (\S+) (.+)$/.exec(item);
    if (whitelistMatch) {
      return { field: whitelistMatch[1], message: item };
    }

    // Standard constraint: "<field> <rest>"
    const spaceIndex = item.indexOf(' ');
    if (spaceIndex === -1) {
      return { field: 'unknown', message: item };
    }
    return {
      field: item.slice(0, spaceIndex),
      message: item.slice(spaceIndex + 1),
    };
  });
}

/**
 * Global RFC 7807 Problem Details exception filter.
 *
 * Handles four exception categories in order of specificity:
 * 1. {@link DomainError} — maps to the error's `typeUri` and `httpStatus`.
 * 2. {@link BadRequestException} — 400 with parsed `errors[]` array.
 * 3. ThrottlerException (matched by constructor name; package not yet installed)
 *    — 429 with the `rate-limited` type URI.
 * 4. Generic {@link HttpException} — fallback RFC 7807 envelope.
 *
 * All responses carry:
 * - `Content-Type: application/problem+json` (REQ-ERR-01)
 * - `correlation_id` from `X-Correlation-ID` when present (REQ-ERR-02)
 * - `timestamp` ISO-8601 string
 *
 * @req REQ-ERR-01
 * @req REQ-ERR-02
 * @req REQ-ERR-03
 * @req REQ-ERR-04
 * @req REQ-ERR-05
 */
@Catch(DomainError, HttpException)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError | HttpException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const correlationId = request.headers['x-correlation-id'];
    const instance = request.url;
    const timestamp = new Date().toISOString();

    const extra: Record<string, unknown> = {};
    if (typeof correlationId === 'string' && correlationId.length > 0) {
      extra.correlation_id = correlationId;
    }

    let body: Record<string, unknown>;

    if (error instanceof DomainError) {
      body = {
        type: error.typeUri,
        title: error.name,
        status: error.httpStatus,
        detail: error.message,
        instance,
        timestamp,
        ...extra,
      };
      this.send(response, error.httpStatus, body);
      return;
    }

    if (error instanceof BadRequestException) {
      const exResponse = error.getResponse() as
        | { message: unknown; error?: string; statusCode?: number }
        | string;

      const rawMessages =
        typeof exResponse === 'object' && exResponse !== null ? exResponse.message : exResponse;

      body = {
        type: VALIDATION_ERROR_TYPE,
        title: 'ValidationError',
        status: 400,
        detail: 'Request validation failed.',
        instance,
        errors: parseValidationMessages(rawMessages),
        timestamp,
        ...extra,
      };
      this.send(response, 400, body);
      return;
    }

    // ThrottlerException is not installed yet; detect by constructor name or
    // HTTP status 429 (ADR-008 guidance: safe-fallthrough for missing deps).
    const httpStatus = error.getStatus();
    if (error.constructor.name === 'ThrottlerException' || httpStatus === 429) {
      body = {
        type: RATE_LIMIT_TYPE,
        title: 'TooManyRequests',
        status: 429,
        detail: 'Rate limit exceeded. Please retry after a moment.',
        instance,
        timestamp,
        ...extra,
      };
      this.send(response, 429, body);
      return;
    }

    // Generic HttpException fallback
    const exResponse = error.getResponse() as { message?: unknown } | string;
    const detail =
      typeof exResponse === 'string'
        ? exResponse
        : typeof exResponse === 'object' && typeof exResponse.message === 'string'
          ? exResponse.message
          : error.message;

    body = {
      type: HTTP_ERROR_TYPE,
      title: error.name,
      status: httpStatus,
      detail,
      instance,
      timestamp,
      ...extra,
    };
    this.send(response, httpStatus, body);
  }

  /**
   * Writes the RFC 7807 Problem Details response with the correct Content-Type.
   * Express sets `Content-Type` inside `json()` only when it has not already
   * been explicitly set, so calling `setHeader` before `json` is sufficient.
   */
  private send(response: Response, status: number, body: Record<string, unknown>): void {
    response.status(status).setHeader('Content-Type', 'application/problem+json').json(body);
  }
}

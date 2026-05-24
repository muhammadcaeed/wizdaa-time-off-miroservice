import { ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from './domain-error';

/**
 * Maps {@link DomainError} subtypes to HTTP responses: the error's status and a
 * `type`/`title`/`detail` body keyed off its `typeUri`. This carries the error
 * contract (status code + stable type URI) that the API promises; the full
 * RFC 7807 Problem Details envelope (correlation_id, field arrays, content-type)
 * is layered on in a later cycle. Non-domain exceptions fall through to Nest's
 * default handler (e.g. 401 from the auth guard).
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    response.status(error.httpStatus).json({
      type: error.typeUri,
      title: error.name,
      status: error.httpStatus,
      detail: error.message,
      instance: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

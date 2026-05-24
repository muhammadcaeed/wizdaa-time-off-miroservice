import { DomainError } from './domain-error';

/** No request exists with the given id. Maps to 404 `/errors/request-not-found`. */
export class RequestNotFoundError extends DomainError {
  readonly httpStatus = 404;
  readonly typeUri = '/errors/request-not-found';

  constructor() {
    super('Request not found');
  }
}

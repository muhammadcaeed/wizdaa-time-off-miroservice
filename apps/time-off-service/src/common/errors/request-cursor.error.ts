import { DomainError } from './domain-error';

/**
 * The pagination cursor supplied to the requests list endpoint could not be
 * decoded. The service generates every cursor, so a malformed one is a client
 * error (tampered or truncated), not a server fault. Maps to 400
 * `/errors/invalid-cursor` (api-contract.md §5).
 */
export class RequestCursorError extends DomainError {
  readonly httpStatus = 400;
  readonly typeUri = '/errors/invalid-cursor';

  constructor() {
    super('Invalid pagination cursor');
  }
}

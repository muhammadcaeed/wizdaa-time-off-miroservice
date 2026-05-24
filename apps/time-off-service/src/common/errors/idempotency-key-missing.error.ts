import { DomainError } from './domain-error';

/**
 * The `Idempotency-Key` header was absent on a POST endpoint.
 * The header is required on all write endpoints (api-contract.md §6).
 * Maps to 400 Bad Request.
 */
export class IdempotencyKeyMissingError extends DomainError {
  readonly httpStatus = 400;
  readonly typeUri = '/errors/idempotency-key-missing';

  constructor() {
    super('Idempotency-Key header is required on all POST endpoints.');
  }
}

import { DomainError } from './domain-error';

/**
 * The `Idempotency-Key` header was present but not a valid UUID v4.
 * Maps to 400 Bad Request (api-contract.md §6).
 */
export class IdempotencyKeyInvalidError extends DomainError {
  readonly httpStatus = 400;
  readonly typeUri = 'https://api.wizdaa.dev/errors/idempotency-key-invalid';

  constructor() {
    super('Idempotency-Key must be a valid UUID.');
  }
}

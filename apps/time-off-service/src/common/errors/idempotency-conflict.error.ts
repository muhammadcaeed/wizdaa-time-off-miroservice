import { DomainError } from './domain-error';

/**
 * The same `Idempotency-Key` was reused with a different request payload.
 * Maps to 409 Conflict with a stable type URI (api-contract.md §6).
 */
export class IdempotencyConflictError extends DomainError {
  readonly httpStatus = 409;
  readonly typeUri = 'https://api.wizdaa.dev/errors/idempotency-conflict';

  constructor() {
    super('Idempotency-Key reused with different request payload.');
  }
}

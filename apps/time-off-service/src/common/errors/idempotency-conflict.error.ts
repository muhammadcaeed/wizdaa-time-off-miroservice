import { DomainError } from './domain-error';

/**
 * The same `Idempotency-Key` was reused with a different request payload.
 * Maps to 422 Unprocessable Entity with a stable type URI (api-contract.md §6).
 */
export class IdempotencyConflictError extends DomainError {
  readonly httpStatus = 422;
  readonly typeUri = '/errors/idempotency-conflict';

  constructor() {
    super('Idempotency-Key reused with different request payload.');
  }
}

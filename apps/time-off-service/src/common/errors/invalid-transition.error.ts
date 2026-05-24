import { DomainError } from './domain-error';

/**
 * A state transition was attempted from a status that no longer matches (the
 * status-predicate CAS matched zero rows, or a guard rejected the jump).
 * Maps to 409 `/errors/invalid-state-transition` (api-contract.md §4, TRD §10.2).
 */
export class InvalidTransitionError extends DomainError {
  readonly httpStatus = 409;
  readonly typeUri = '/errors/invalid-state-transition';

  constructor(requestId: string) {
    super(`Request ${requestId} is not in the expected state for this transition`);
  }
}

import { DomainError } from './domain-error';

/** No reconciliation run exists with the given id. Maps to 404 `/errors/reconciliation-not-found` (api-contract.md §2). */
export class ReconciliationNotFoundError extends DomainError {
  readonly httpStatus = 404;
  readonly typeUri = '/errors/reconciliation-not-found';

  constructor() {
    super('Reconciliation run not found');
  }
}

import { DomainError } from './domain-error';

/**
 * A reconciliation run was requested while another run is in `RUNNING` state.
 * Maps to 409 `/errors/reconciliation-in-progress` (REQ-REC-06,
 * api-contract.md §4). Only one tracked run may be in flight at a time
 * (enforced by the partial UNIQUE index on `reconciliations`); the caller
 * retries once the active run completes.
 */
export class ReconciliationInProgressError extends DomainError {
  readonly httpStatus = 409;
  readonly typeUri = '/errors/reconciliation-in-progress';

  constructor() {
    super('A reconciliation run is already in progress');
  }
}

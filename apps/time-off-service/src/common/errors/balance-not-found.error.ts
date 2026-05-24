import { DomainError } from './domain-error';

/**
 * No local balance row exists for the (employee, location) pair. Balances are
 * seeded/reconciled from HCM; a missing one is a 404 `/errors/balance-not-found`.
 */
export class BalanceNotFoundError extends DomainError {
  readonly httpStatus = 404;
  readonly typeUri = '/errors/balance-not-found';

  constructor() {
    super('No balance exists for this employee and location');
  }
}

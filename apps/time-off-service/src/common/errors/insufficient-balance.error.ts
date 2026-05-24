import { DomainError } from './domain-error';

/**
 * A submission (or retry) asked for more days than are available
 * (`total_days - reserved_days`). Maps to 409 `/errors/insufficient-balance`
 * (REQ-LIFE-02, api-contract.md §4).
 */
export class InsufficientBalanceError extends DomainError {
  readonly httpStatus = 409;
  readonly typeUri = '/errors/insufficient-balance';

  constructor(
    readonly availableDays: number,
    readonly requestedDays: number,
  ) {
    super(
      `Available balance (${availableDays} days) is less than requested (${requestedDays} days)`,
    );
  }
}

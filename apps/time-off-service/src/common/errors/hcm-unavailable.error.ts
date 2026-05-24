import { DomainError } from './domain-error';

/**
 * The HCM circuit breaker is OPEN, so an approval/cancellation that requires an
 * HCM call is fast-failed before any state transition. Maps to 503
 * `/errors/hcm-unavailable` (REQ-SYNC-06, TRD §11.2, api-contract.md §4). The
 * request stays in its current (non-transient) state and can be retried once
 * the breaker recovers.
 */
export class HcmUnavailableError extends DomainError {
  readonly httpStatus = 503;
  readonly typeUri = '/errors/hcm-unavailable';

  constructor() {
    super('HCM is temporarily unavailable (circuit breaker open); retry later');
  }
}

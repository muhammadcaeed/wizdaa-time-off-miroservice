import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { CircuitBreaker, type BreakerSnapshot } from './circuit-breaker';

/**
 * Operational visibility into the HCM circuit breaker (TRD §11.2, Plan 03
 * acceptance criterion 10). Admin-only: breaker state can reveal HCM health and
 * is not a tenant-facing concern. A simple JSON readout — the Prometheus gauge
 * in TRD §14.3 is out of scope.
 */
@Controller('admin/hcm')
export class HcmAdminController {
  constructor(private readonly breaker: CircuitBreaker) {}

  /**
   * Returns the current circuit breaker state for operators.
   * @returns the breaker snapshot (state, consecutive failures, window, openUntil)
   */
  @Get('breaker')
  @Roles('ADMIN')
  getBreakerState(): BreakerSnapshot {
    return this.breaker.snapshot();
  }
}

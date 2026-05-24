import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { HealthService, type HealthResult } from './health.service';

/**
 * Health endpoint controller (TRD §14.2).
 *
 * Decorated with `@Public()` to bypass the global JwtAuthGuard and
 * `@SkipThrottle()` to exempt it from rate limiting — liveness checks must
 * never be throttled.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Composite health check. Returns 200 for healthy/degraded and 503 for
   * unhealthy (DB down). The full result body is included in all cases.
   *
   * @returns composite health result
   * @throws ServiceUnavailableException when the service is unhealthy
   */
  @Get()
  @HttpCode(200)
  async getHealth(): Promise<HealthResult> {
    const result = await this.healthService.check();
    if (result.status === 'unhealthy') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}

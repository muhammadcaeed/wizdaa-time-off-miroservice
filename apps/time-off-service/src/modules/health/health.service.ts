import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BREAKER_STATE } from '../hcm-sync/circuit-breaker';
import { CircuitBreaker } from '../hcm-sync/circuit-breaker';

/** Overall service health status (TRD §14.2). */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** HCM circuit state as reported in the health response. */
export type HcmCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Health check result shape (TRD §14.2). */
export interface HealthResult {
  status: HealthStatus;
  checks: {
    database: {
      status: 'up' | 'down';
      response_time_ms: number;
    };
    hcm: {
      status: 'up' | 'down' | 'unknown';
      circuit_state: HcmCircuitState;
    };
  };
  timestamp: string;
}

/**
 * Composite health check service (TRD §14.2).
 *
 * Status derivation:
 * - `unhealthy` — DB is down
 * - `degraded`  — DB is up AND HCM circuit is OPEN
 * - `healthy`   — DB is up AND HCM circuit is CLOSED or HALF_OPEN
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly circuitBreaker: CircuitBreaker,
  ) {}

  /**
   * Runs all sub-checks and returns the composite health result.
   *
   * @returns composite health result
   */
  async check(): Promise<HealthResult> {
    const dbCheck = await this.checkDatabase();
    const hcmCheck = this.checkHcm();

    const status = this.deriveStatus(dbCheck.status, hcmCheck.circuit_state);

    return {
      status,
      checks: {
        database: dbCheck,
        hcm: hcmCheck,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Runs `SELECT 1` against the live DataSource to verify liveness.
   * Records wall-clock response time in milliseconds.
   *
   * @returns database check result
   */
  private async checkDatabase(): Promise<HealthResult['checks']['database']> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up', response_time_ms: Date.now() - start };
    } catch {
      return { status: 'down', response_time_ms: Date.now() - start };
    }
  }

  /**
   * Reads the circuit breaker snapshot without side effects.
   *
   * @returns HCM check result
   */
  private checkHcm(): HealthResult['checks']['hcm'] {
    const snap = this.circuitBreaker.snapshot();
    const circuit_state = snap.state;

    // OPEN means HCM is not accepting calls; CLOSED/HALF_OPEN means calls can pass.
    const status: 'up' | 'down' | 'unknown' = circuit_state === BREAKER_STATE.OPEN ? 'down' : 'up';

    return { status, circuit_state };
  }

  /**
   * Derives the overall service status from sub-check results.
   *
   * @param dbStatus - database liveness
   * @param circuitState - HCM circuit breaker state
   * @returns overall health status
   */
  private deriveStatus(dbStatus: 'up' | 'down', circuitState: HcmCircuitState): HealthStatus {
    if (dbStatus === 'down') {
      return 'unhealthy';
    }
    if (circuitState === BREAKER_STATE.OPEN) {
      return 'degraded';
    }
    return 'healthy';
  }
}

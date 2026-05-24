import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BREAKER_STATE } from '../hcm-sync/circuit-breaker';
import type { BreakerSnapshot } from '../hcm-sync/circuit-breaker';
import { CircuitBreaker } from '../hcm-sync/circuit-breaker';
import { HealthService } from './health.service';

/**
 * @req REQ-HEALTH-01
 */
describe('HealthService', () => {
  let service: HealthService;
  let dataSource: { query: ReturnType<typeof vi.fn> };
  let circuitBreaker: { snapshot: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dataSource = { query: vi.fn() };
    circuitBreaker = { snapshot: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DataSource, useValue: dataSource },
        { provide: CircuitBreaker, useValue: circuitBreaker },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  it('returns healthy when DB is up and HCM circuit is CLOSED', async () => {
    dataSource.query.mockResolvedValue([{ 1: 1 }]);
    circuitBreaker.snapshot.mockReturnValue({
      state: BREAKER_STATE.CLOSED,
      consecutiveFailures: 0,
      window: [],
      openUntil: null,
    } satisfies BreakerSnapshot);

    const result = await service.check();

    expect(result.status).toBe('healthy');
    expect(result.checks.database.status).toBe('up');
    expect(result.checks.hcm.circuit_state).toBe('CLOSED');
    expect(result.checks.hcm.status).toBe('up');
    expect(typeof result.checks.database.response_time_ms).toBe('number');
    expect(result.timestamp).toBeDefined();
  });

  it('returns healthy when DB is up and HCM circuit is HALF_OPEN', async () => {
    dataSource.query.mockResolvedValue([{ 1: 1 }]);
    circuitBreaker.snapshot.mockReturnValue({
      state: BREAKER_STATE.HALF_OPEN,
      consecutiveFailures: 0,
      window: [],
      openUntil: null,
    } satisfies BreakerSnapshot);

    const result = await service.check();

    expect(result.status).toBe('healthy');
    expect(result.checks.hcm.circuit_state).toBe('HALF_OPEN');
    expect(result.checks.hcm.status).toBe('up');
  });

  it('returns degraded when DB is up and HCM circuit is OPEN', async () => {
    dataSource.query.mockResolvedValue([{ 1: 1 }]);
    circuitBreaker.snapshot.mockReturnValue({
      state: BREAKER_STATE.OPEN,
      consecutiveFailures: 5,
      window: [],
      openUntil: Date.now() + 30000,
    } satisfies BreakerSnapshot);

    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.checks.database.status).toBe('up');
    expect(result.checks.hcm.circuit_state).toBe('OPEN');
    expect(result.checks.hcm.status).toBe('down');
  });

  it('returns unhealthy when DB is down regardless of HCM state', async () => {
    dataSource.query.mockRejectedValue(new Error('SQLITE_CANTOPEN'));
    circuitBreaker.snapshot.mockReturnValue({
      state: BREAKER_STATE.CLOSED,
      consecutiveFailures: 0,
      window: [],
      openUntil: null,
    } satisfies BreakerSnapshot);

    const result = await service.check();

    expect(result.status).toBe('unhealthy');
    expect(result.checks.database.status).toBe('down');
  });

  it('records a non-negative response_time_ms for DB check', async () => {
    dataSource.query.mockResolvedValue([{ 1: 1 }]);
    circuitBreaker.snapshot.mockReturnValue({
      state: BREAKER_STATE.CLOSED,
      consecutiveFailures: 0,
      window: [],
      openUntil: null,
    } satisfies BreakerSnapshot);

    const result = await service.check();

    expect(result.checks.database.response_time_ms).toBeGreaterThanOrEqual(0);
  });
});

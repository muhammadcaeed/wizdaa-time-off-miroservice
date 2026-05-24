import { Body, Controller, Get, Post } from '@nestjs/common';
import { InjectBalanceDto, SetScenarioDto } from '../dto/control.dto';
import { type CallLogEntry, CallLogService } from '../services/call-log.service';
import { IdempotencyService } from '../services/idempotency.service';
import { type ScenarioAssignment, ScenarioService } from '../services/scenario.service';
import { type BalanceRow, StorageService } from '../services/storage.service';

/** Observable mock state for test assertions (mock-hcm.md §3.5). */
interface MockState {
  scenarios: ScenarioAssignment[];
  storage: BalanceRow[];
  idempotencyKeys: string[];
}

/**
 * Test-only control plane for scenario injection and state inspection
 * (mock-hcm.md §3).
 */
@Controller('mock/control')
export class ControlController {
  constructor(
    private readonly storage: StorageService,
    private readonly scenarios: ScenarioService,
    private readonly idempotency: IdempotencyService,
    private readonly callLog: CallLogService,
  ) {}

  /**
   * Restores the mock to its default state: scenarios cleared, storage
   * re-seeded from the fixture, idempotency cache emptied (mock-hcm.md §3.4).
   * @returns nothing
   */
  @Post('reset')
  reset(): void {
    this.storage.reset();
    this.scenarios.reset();
    this.idempotency.reset();
    this.callLog.reset();
  }

  /**
   * Injects or overwrites a stored balance (mock-hcm.md §3.2).
   * @param body the balance to inject
   * @returns nothing
   */
  @Post('balances')
  injectBalance(@Body() body: InjectBalanceDto): void {
    this.storage.upsert({
      employee_id: body.employee_id,
      location_id: body.location_id,
      total_days: body.total_days,
      last_modified_at: body.last_modified_at ?? new Date().toISOString(),
    });
  }

  /**
   * Records a per-endpoint scenario, optionally scoped (mock-hcm.md §3.1).
   * @param body the scenario assignment
   * @returns nothing
   */
  @Post('scenarios')
  setScenario(@Body() body: SetScenarioDto): void {
    this.scenarios.set({ endpoints: body.endpoints, scope: body.scope });
  }

  /**
   * Returns the current mock state for assertions (mock-hcm.md §3.5).
   * @returns scenarios, storage contents, and idempotency keys
   */
  @Get('state')
  state(): MockState {
    return {
      scenarios: this.scenarios.snapshot(),
      storage: this.storage.snapshot(),
      idempotencyKeys: this.idempotency.keys(),
    };
  }

  /**
   * Returns the recent HCM-surface call log (mock-hcm.md §3.6), used by
   * contract and chaos tests to assert what the client sent on each attempt.
   * @returns the recorded calls, oldest first
   */
  @Get('calls')
  calls(): { calls: CallLogEntry[] } {
    return { calls: this.callLog.list() };
  }
}

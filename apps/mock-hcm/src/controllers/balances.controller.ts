import { randomUUID } from 'node:crypto';
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { AdjustRequestDto } from '../dto/adjust.dto';
import { IdempotencyService } from '../services/idempotency.service';
import { ScenarioService } from '../services/scenario.service';
import { StorageService } from '../services/storage.service';

/** Adjust response shape (mock-hcm.md §2.2, TRD §9.1). */
interface AdjustResponse {
  employee_id: string;
  location_id: string;
  new_total_days: number;
  hcm_correlation_id: string;
  timestamp: string;
}

/** Balance read response shape (mock-hcm.md §2.1). */
interface BalancesResponse {
  employee_id: string;
  balances: { location_id: string; total_days: number; last_modified_at: string }[];
}

/**
 * Mirrors the assumed HCM balance surface (mock-hcm.md §2, TRD §9.1).
 */
@Controller('hcm/balances')
export class BalancesController {
  constructor(
    private readonly storage: StorageService,
    private readonly scenarios: ScenarioService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Returns every balance row for an employee.
   * @param employeeId employee identifier from the path
   * @returns 200 with the employee's balances
   * @throws NotFoundException if the employee is unknown
   */
  @Get(':employee_id')
  getBalances(@Param('employee_id') employeeId: string): BalancesResponse {
    const rows = this.storage.findByEmployee(employeeId);
    if (rows.length === 0) {
      throw new NotFoundException(`Unknown employee ${employeeId}`);
    }
    return {
      employee_id: employeeId,
      balances: rows.map((row) => ({
        location_id: row.location_id,
        total_days: row.total_days,
        last_modified_at: row.last_modified_at,
      })),
    };
  }

  /**
   * Applies a balance adjustment, idempotent under the Idempotency-Key header.
   * @param idempotencyKey the Idempotency-Key header value
   * @param body the adjust request
   * @returns 200 with the new total and a fresh correlation id
   * @throws ConflictException on a duplicate key with a different body
   * @throws NotFoundException if the (employee, location) pair is unknown
   */
  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  adjust(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: AdjustRequestDto,
  ): AdjustResponse {
    if (idempotencyKey !== undefined) {
      const cached = this.idempotency.lookup(idempotencyKey, body);
      if (cached.kind === 'replay') {
        return cached.body as AdjustResponse;
      }
      if (cached.kind === 'conflict') {
        throw new ConflictException('Idempotency-Key reused with a different body');
      }
    }

    const row = this.storage.find(body.employee_id, body.location_id);
    if (row === undefined) {
      throw new NotFoundException(`Unknown balance for ${body.employee_id}:${body.location_id}`);
    }

    const scenario = this.scenarios.resolve('adjust', body.employee_id, body.location_id);
    const preTotal = row.total_days;
    let newTotal: number;
    switch (scenario) {
      case 'ambiguous-success':
        // 2xx but storage does not change; reported total stays at the pre-total.
        newTotal = preTotal;
        break;
      case 'unverifiable-success':
        // 2xx reporting a total that disagrees with pre + delta; storage unchanged.
        newTotal = preTotal + body.delta + 1;
        break;
      case 'normal':
      default:
        newTotal = this.storage.applyDelta(body.employee_id, body.location_id, body.delta);
        break;
    }

    const response: AdjustResponse = {
      employee_id: body.employee_id,
      location_id: body.location_id,
      new_total_days: newTotal,
      hcm_correlation_id: `hcm_op_${randomUUID()}`,
      timestamp: new Date().toISOString(),
    };

    if (idempotencyKey !== undefined) {
      this.idempotency.store(idempotencyKey, body, HttpStatus.OK, response);
    }
    return response;
  }
}

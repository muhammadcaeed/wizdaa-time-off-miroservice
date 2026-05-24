import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdjustQueryDto, AdjustRequestDto } from '../dto/adjust.dto';
import { BatchQueryDto } from '../dto/batch.dto';
import { IdempotencyService } from '../services/idempotency.service';
import { type ScenarioName, ScenarioService } from '../services/scenario.service';
import { type BalanceRow, StorageService } from '../services/storage.service';

/** Default latency injected by the `slow` scenario (mock-hcm.md §4). */
const DEFAULT_SLOW_LATENCY_MS = 2000;

/** Default failure fraction for the `flaky` scenario (mock-hcm.md §4). */
const DEFAULT_FAIL_RATE = 0.3;

/** Default page size for the batch endpoint when `limit` is omitted (api-contract.md §5). */
const DEFAULT_BATCH_LIMIT = 50;

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

/** Paginated batch response shape (mock-hcm.md §2.3, api-contract.md §5). */
interface BatchResponse {
  data: BalanceRow[];
  pagination: { next_cursor: string | null; has_more: boolean };
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
   * Returns the corpus of balances modified at or after `since`, paginated with
   * an opaque cursor (mock-hcm.md §2.3, api-contract.md §5). Declared before the
   * `:employee_id` route so the literal `batch` segment isn't captured as a path
   * param.
   *
   * Chaos scenarios are resolved corpus-wide via an unscoped `resolve('batch')`
   * and applied exactly as the adjust endpoint does (mock-hcm.md §4): `slow`
   * delays, `down` 503s, `flaky` 5xxs deterministically, `network-failure`
   * destroys the socket. The `@Res` handle serves both the socket-destroy path
   * and the JSON write.
   *
   * @param query `since` (required ISO-8601), opaque `cursor`, `limit`, and the
   *   per-request chaos knobs (`latency_ms`, `fail_rate`)
   * @param res the raw express response (for socket destroy + serialization)
   * @returns nothing; the response is written via `res`
   * @throws BadRequestException if the cursor is malformed
   * @throws ServiceUnavailableException under the `down`/`flaky` scenarios
   */
  @Get('batch')
  async batch(@Query() query: BatchQueryDto, @Res() res: Response): Promise<void> {
    // Corpus-wide query: empty scope ids mean only unscoped batch scenarios apply.
    const scenario = this.scenarios.resolve('batch', '', '');

    if (scenario === 'slow') {
      await delay(query.latency_ms ?? DEFAULT_SLOW_LATENCY_MS);
    }

    if (scenario === 'network-failure') {
      res.socket?.destroy();
      return;
    }

    if (scenario === 'down') {
      throw new ServiceUnavailableException('HCM is down (mock scenario)');
    }

    if (
      scenario === 'flaky' &&
      this.scenarios.shouldFlakyFail('batch', query.fail_rate ?? DEFAULT_FAIL_RATE)
    ) {
      throw new ServiceUnavailableException('HCM flaky failure (mock scenario)');
    }

    let page;
    try {
      page = this.storage.batchSince(
        new Date(query.since),
        query.cursor,
        query.limit ?? DEFAULT_BATCH_LIMIT,
      );
    } catch {
      throw new BadRequestException('Malformed cursor');
    }

    const response: BatchResponse = {
      data: page.rows,
      pagination: { next_cursor: page.nextCursor, has_more: page.hasMore },
    };
    res.status(HttpStatus.OK).json(response);
  }

  /**
   * Returns every balance row for an employee.
   *
   * Chaos scenarios are resolved employee-scoped via `resolve('get_balance', …)`
   * and applied exactly as the batch endpoint does (mock-hcm.md §4): `slow`
   * delays, `down` 503s, `flaky` 5xxs deterministically, `network-failure`
   * destroys the socket. The `@Res` handle serves both the socket-destroy path
   * and the JSON write.
   *
   * @param employeeId employee identifier from the path
   * @param query the per-request chaos knobs (`latency_ms`, `fail_rate`)
   * @param res the raw express response (for socket destroy + serialization)
   * @returns nothing; the response is written via `res`
   * @throws NotFoundException if the employee is unknown
   * @throws ServiceUnavailableException under the `down`/`flaky` scenarios
   */
  @Get(':employee_id')
  async getBalances(
    @Param('employee_id') employeeId: string,
    @Query() query: AdjustQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    // Location-agnostic: get-balance is per-employee, so the scenario scope omits location.
    const scenario = this.scenarios.resolve('get_balance', employeeId, '');

    if (scenario === 'slow') {
      await delay(query.latency_ms ?? DEFAULT_SLOW_LATENCY_MS);
    }

    if (scenario === 'network-failure') {
      res.socket?.destroy();
      return;
    }

    if (scenario === 'down') {
      throw new ServiceUnavailableException('HCM is down (mock scenario)');
    }

    if (
      scenario === 'flaky' &&
      this.scenarios.shouldFlakyFail('get_balance', query.fail_rate ?? DEFAULT_FAIL_RATE)
    ) {
      throw new ServiceUnavailableException('HCM flaky failure (mock scenario)');
    }

    const rows = this.storage.findByEmployee(employeeId);
    if (rows.length === 0) {
      throw new NotFoundException(`Unknown employee ${employeeId}`);
    }
    const response: BalancesResponse = {
      employee_id: employeeId,
      balances: rows.map((row) => ({
        location_id: row.location_id,
        total_days: row.total_days,
        last_modified_at: row.last_modified_at,
      })),
    };
    res.status(HttpStatus.OK).json(response);
  }

  /**
   * Applies a balance adjustment, idempotent under the Idempotency-Key header.
   *
   * Chaos scenarios (mock-hcm.md §4) are applied before the business logic:
   * `slow` delays, `down` always 503s, `flaky` 5xxs deterministically, and
   * `network-failure` destroys the socket so the client sees a transport error
   * rather than a clean HTTP response. The `@Res` handle is required for the
   * socket-destroy path; success and thrown exceptions still flow through it.
   *
   * @param idempotencyKey the Idempotency-Key header value
   * @param query per-request chaos knobs (`latency_ms`, `fail_rate`)
   * @param body the adjust request
   * @param res the raw express response (for socket destroy + serialization)
   * @returns nothing; the response is written via `res`
   * @throws ConflictException on a duplicate key with a different body
   * @throws NotFoundException if the (employee, location) pair is unknown
   * @throws ServiceUnavailableException under the `down`/`flaky` scenarios
   */
  @Post('adjust')
  async adjust(
    @Headers('idempotency-key') idempotencyKey: string,
    @Query() query: AdjustQueryDto,
    @Body() body: AdjustRequestDto,
    @Res() res: Response,
  ): Promise<void> {
    const scenario = this.scenarios.resolve('adjust', body.employee_id, body.location_id);

    if (scenario === 'slow') {
      await delay(query.latency_ms ?? DEFAULT_SLOW_LATENCY_MS);
    }

    if (scenario === 'network-failure') {
      // Destroy the socket mid-response so the client observes an
      // ECONNRESET-style transport error, not a clean 5xx (mock-hcm.md §4).
      res.socket?.destroy();
      return;
    }

    if (scenario === 'down') {
      throw new ServiceUnavailableException('HCM is down (mock scenario)');
    }

    if (
      scenario === 'flaky' &&
      this.scenarios.shouldFlakyFail('adjust', query.fail_rate ?? DEFAULT_FAIL_RATE)
    ) {
      throw new ServiceUnavailableException('HCM flaky failure (mock scenario)');
    }

    const response = this.applyAdjust(idempotencyKey, body, scenario);
    res.status(HttpStatus.OK).json(response);
  }

  /**
   * Runs the idempotent balance-adjust business logic, separated so the chaos
   * branches in {@link adjust} stay readable.
   * @param idempotencyKey the Idempotency-Key header value
   * @param body the adjust request
   * @param scenario the resolved scenario (`normal` or a success variant)
   * @returns the adjust response (a fresh result or an idempotent replay)
   * @throws ConflictException on a duplicate key with a different body
   * @throws NotFoundException if the (employee, location) pair is unknown
   */
  private applyAdjust(
    idempotencyKey: string,
    body: AdjustRequestDto,
    scenario: ScenarioName,
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

    // F-05 (REQ-SYNC-08): a real HCM rejects a decrement that would drive the
    // balance negative with 409 insufficient_balance. The success-variant
    // scenarios (ambiguous/unverifiable) deliberately bypass this so they can
    // still exercise their 2xx arithmetic-mismatch paths.
    const isSuccessVariant =
      scenario === 'ambiguous-success' || scenario === 'unverifiable-success';
    if (!isSuccessVariant && row.total_days + body.delta < 0) {
      throw new ConflictException('insufficient_balance');
    }

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

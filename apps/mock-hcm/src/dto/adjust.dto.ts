import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min, MinLength, IsString } from 'class-validator';

/**
 * Adjust request body (mock-hcm.md §2.2, TRD §9.1). Independent from the main
 * service's DTOs so serialization mismatches surface (mock-hcm.md §7).
 */
export class AdjustRequestDto {
  @IsString()
  @MinLength(1)
  employee_id!: string;

  @IsString()
  @MinLength(1)
  location_id!: string;

  @IsInt()
  delta!: number;

  @IsIn(['DECREMENT', 'INCREMENT'])
  operation_type!: 'DECREMENT' | 'INCREMENT';

  @IsString()
  @MinLength(1)
  source_reference!: string;
}

/**
 * Per-request chaos knobs for the adjust endpoint (mock-hcm.md §4). Override
 * the `slow` and `flaky` scenario defaults. Parsed from the query string;
 * `@Type` coerces the inbound strings to numbers.
 */
export class AdjustQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  latency_ms?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  fail_rate?: number;
}

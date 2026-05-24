import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query parameters for GET /hcm/balances/batch (mock-hcm.md §2.3,
 * api-contract.md §5), including the per-request chaos knobs (mock-hcm.md §4).
 * The chaos fields live here, not in a second `@Query` DTO, because a global
 * `forbidNonWhitelisted` pipe rejects fields absent from whichever DTO it binds.
 * `@Type` coerces the inbound query strings; `limit` is floor-validated here and
 * clamped to the maximum in the storage layer.
 */
export class BatchQueryDto {
  @IsISO8601()
  since!: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

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

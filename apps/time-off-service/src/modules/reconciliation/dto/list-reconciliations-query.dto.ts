import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Maximum page size accepted from the client (api-contract.md §5). */
const MAX_LIMIT = 100;

/**
 * Query parameters for GET /api/v1/reconciliations (api-contract.md §5).
 * `@Type` coerces the inbound query strings under the global transforming pipe;
 * the repository clamps `limit` to its own maximum as a defence in depth.
 */
export class ListReconciliationsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
}

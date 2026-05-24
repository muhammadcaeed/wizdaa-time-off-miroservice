import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Valid request status values for the status filter. */
const VALID_STATUSES = [
  'SUBMITTED',
  'APPROVING',
  'APPROVED',
  'APPROVAL_FAILED',
  'REJECTED',
  'CANCELLING',
  'CANCELLATION_FAILED',
  'CANCELLED',
] as const;

/**
 * Query parameters for GET /api/v1/requests (api-contract.md §5).
 * `@Type` coerces the inbound query strings under the global transforming pipe.
 */
export class ListRequestsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(VALID_STATUSES)
  status?: string;
}

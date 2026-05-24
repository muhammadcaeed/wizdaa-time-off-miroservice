import { IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';

/**
 * Submit-a-request payload (POST /api/v1/requests). The owner is the
 * authenticated `sub`, never taken from the body. Validated by the global
 * ValidationPipe in whitelist mode; unknown fields are rejected (TRD §13.2).
 * The `end_date >= start_date` cross-field rule is enforced in the service.
 */
export class SubmitRequestDto {
  @IsString()
  location_id!: string;

  @IsISO8601()
  start_date!: string;

  @IsISO8601()
  end_date!: string;

  @IsInt()
  @Min(1)
  days_requested!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

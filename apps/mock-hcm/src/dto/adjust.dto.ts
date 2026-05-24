import { IsIn, IsInt, IsString, MinLength } from 'class-validator';

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

import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

const SCENARIOS = [
  'normal',
  'ambiguous-success',
  'unverifiable-success',
  'slow',
  'flaky',
  'down',
  'network-failure',
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

/** Inject/overwrite a stored balance (mock-hcm.md §3.2). */
export class InjectBalanceDto {
  @IsString()
  @MinLength(1)
  employee_id!: string;

  @IsString()
  @MinLength(1)
  location_id!: string;

  @IsInt()
  total_days!: number;

  @IsOptional()
  @IsString()
  last_modified_at?: string;
}

/** Per-endpoint scenario map for POST /mock/control/scenarios. */
export class ScenarioEndpointsDto {
  @IsOptional()
  @IsIn(SCENARIOS)
  adjust?: ScenarioName;

  @IsOptional()
  @IsIn(SCENARIOS)
  get_balance?: ScenarioName;

  @IsOptional()
  @IsIn(SCENARIOS)
  batch?: ScenarioName;
}

/** Silently drift a stored balance, leaving last_modified_at untouched (mock-hcm.md §3.3). */
export class DriftBalanceDto {
  @IsString()
  @MinLength(1)
  employee_id!: string;

  @IsString()
  @MinLength(1)
  location_id!: string;

  @IsInt()
  total_days!: number;
}

/** Optional scope narrowing a scenario (mock-hcm.md §3.1). */
export class ScenarioScopeDto {
  @IsOptional()
  @IsString()
  employee_id?: string;

  @IsOptional()
  @IsString()
  location_id?: string;
}

/** Set a scenario, optionally scoped (mock-hcm.md §3.1). */
export class SetScenarioDto {
  @IsObject()
  @ValidateNested()
  @Type(() => ScenarioEndpointsDto)
  endpoints!: ScenarioEndpointsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScenarioScopeDto)
  scope?: ScenarioScopeDto;
}

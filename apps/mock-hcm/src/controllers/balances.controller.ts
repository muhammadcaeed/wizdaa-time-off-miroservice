import { Controller } from '@nestjs/common';

/**
 * Mirrors the assumed HCM balance surface (mock-hcm.md §2, TRD §9.1).
 * Endpoint behavior arrives in Cycle 02 (realtime) and Cycle 04 (batch); the
 * cycle-01 skeleton only needs the controller to register.
 */
@Controller('hcm/balances')
export class BalancesController {}

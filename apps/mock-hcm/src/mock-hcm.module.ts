import { Module } from '@nestjs/common';
import { BalancesController } from './controllers/balances.controller';
import { ControlController } from './controllers/control.controller';

/**
 * Standalone mock HCM (mock-hcm.md §7). Exported as a module so the test
 * harness can mount it in-process; `main.ts` boots it out-of-process.
 */
@Module({
  controllers: [BalancesController, ControlController],
})
export class MockHcmModule {}

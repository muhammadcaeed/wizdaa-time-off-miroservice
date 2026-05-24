import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BalancesController } from './controllers/balances.controller';
import { ControlController } from './controllers/control.controller';
import { CallLogInterceptor } from './interceptors/call-log.interceptor';
import { CallLogService } from './services/call-log.service';
import { IdempotencyService } from './services/idempotency.service';
import { ScenarioService } from './services/scenario.service';
import { StorageService } from './services/storage.service';

/**
 * Standalone mock HCM (mock-hcm.md §7). Exported as a module so the test
 * harness can mount it in-process; `main.ts` boots it out-of-process.
 */
@Module({
  controllers: [BalancesController, ControlController],
  providers: [
    StorageService,
    ScenarioService,
    IdempotencyService,
    CallLogService,
    { provide: APP_INTERCEPTOR, useClass: CallLogInterceptor },
  ],
})
export class MockHcmModule {}

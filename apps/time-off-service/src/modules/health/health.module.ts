import { Module } from '@nestjs/common';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health module. Imports {@link HcmSyncModule} to gain access to the shared
 * {@link CircuitBreaker} singleton for HCM state reporting. The TypeORM
 * DataSource is globally available via TypeOrmModule.forRootAsync so it does
 * not need to be imported here.
 */
@Module({
  imports: [HcmSyncModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}

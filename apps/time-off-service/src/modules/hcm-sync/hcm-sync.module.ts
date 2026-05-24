import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HCM_ADJUSTER } from './hcm-adjuster';
import { HcmClient } from './hcm-client';

/**
 * HCM integration surface. Binds the {@link HCM_ADJUSTER} token to a
 * {@link HcmClient} built from the validated env. The retry/breaker decorator
 * (ADR-008) will wrap this binding in a later cycle without touching consumers.
 */
@Module({
  providers: [
    {
      provide: HCM_ADJUSTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new HcmClient(
          config.getOrThrow<string>('HCM_BASE_URL'),
          config.getOrThrow<number>('HCM_TIMEOUT_MS'),
        ),
    },
  ],
  exports: [HCM_ADJUSTER],
})
export class HcmSyncModule {}

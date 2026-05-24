import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../apps/time-off-service/src/app.module';
import { InitSchema1779625818136 } from '../../apps/time-off-service/src/database/migrations/1779625818136-InitSchema';
import { HCM_ADJUSTER, type HcmAdjuster } from '../../apps/time-off-service/src/modules/hcm-sync/hcm-adjuster';

export interface BootstrapOptions {
  /** Override the HCM adjuster (e.g. a real client pointed at an in-test mock). */
  hcmAdjuster?: HcmAdjuster;
}

export interface E2EContext {
  app: INestApplication;
  /** Typed HTTP server for supertest (avoids the `any` from `getHttpServer`). */
  httpServer: Server;
  dataSource: DataSource;
  close: () => Promise<void>;
}

/**
 * Boots the full Nest app and applies the committed migration to the app's own
 * DataSource (never `synchronize`, per requirements.md §2.3). Migrating the live
 * connection — rather than a separate file — sidesteps ConfigModule's env
 * snapshot and works with the in-memory test DB, which persists for the
 * connection's lifetime.
 */
export async function bootstrapE2E(options: BootstrapOptions = {}): Promise<E2EContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.hcmAdjuster) {
    builder = builder.overrideProvider(HCM_ADJUSTER).useValue(options.hcmAdjuster);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  const dataSource = app.get(DataSource);
  const queryRunner = dataSource.createQueryRunner();
  try {
    await new InitSchema1779625818136().up(queryRunner);
  } finally {
    await queryRunner.release();
  }

  return {
    app,
    httpServer: app.getHttpServer() as Server,
    dataSource,
    close: async () => {
      await app.close();
    },
  };
}

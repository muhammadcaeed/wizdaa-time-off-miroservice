import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MockHcmModule } from './mock-hcm.module';

const DEFAULT_MOCK_HCM_PORT = 4001;

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Mock HCM must never run in production (mock-hcm.md §8.3)');
  }

  const app = await NestFactory.create(MockHcmModule);
  const port = Number(process.env.MOCK_HCM_PORT ?? DEFAULT_MOCK_HCM_PORT);

  await app.listen(port);
  Logger.log(`Mock HCM listening on port ${port}`, 'MockHcmBootstrap');
}

void bootstrap();

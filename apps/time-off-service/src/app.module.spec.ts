import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * Cycle-01 smoke test: the root module compiles and initializes with config,
 * database, and logging wired. No behavioral assertions — those land with the
 * features in later cycles.
 */
describe('AppModule', () => {
  it('compiles', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});

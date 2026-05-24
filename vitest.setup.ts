/**
 * Test environment defaults, applied before test modules import (so
 * decorator-time config like ConfigModule.forRoot sees them). Real values are
 * irrelevant for cycle-01 wiring; later cycles override per-suite as needed.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_FILE ??= ':memory:';
process.env.JWT_SIGNING_KEY ??= 'test-signing-key';
process.env.HCM_BASE_URL ??= 'http://localhost:4001';

import * as Joi from 'joi';

/**
 * Joi schema for environment variables (TRD §14.4).
 *
 * Cycle-01-consumed vars are required; vars whose consuming code arrives in
 * later cycles (circuit breaker, retry, reconciliation, throttling, full auth)
 * are optional with defaults so boot does not fail on config for code that
 * does not exist yet. Each later cycle tightens its own variables to required.
 */
export const envValidationSchema = Joi.object({
  // Service
  PORT: Joi.number().port().default(3000),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  // Database
  DATABASE_FILE: Joi.string().required(),

  // Auth
  JWT_SIGNING_KEY: Joi.string().min(1).required(),
  JWT_LIFETIME_SECONDS: Joi.number().positive().default(3600),

  // HCM client
  HCM_BASE_URL: Joi.string().uri().required(),
  HCM_API_KEY: Joi.string().default(''),
  HCM_TIMEOUT_MS: Joi.number().positive().default(5000),

  // Circuit breaker (Cycle 03)
  HCM_BREAKER_FAILURE_THRESHOLD: Joi.number().positive().default(5),
  HCM_BREAKER_FAILURE_RATE: Joi.number().min(0).max(1).default(0.5),
  HCM_BREAKER_COOLDOWN_MS: Joi.number().positive().default(30000),
  // Deadline for a wedged HALF_OPEN probe to report back before re-OPENing
  // (TRD §11.2). Must exceed the full retry budget — worst case ~4 attempts ×
  // 5s client timeout + backoff (~21s) — or a still-retrying probe gets falsely
  // declared dead and the breaker can't recover. 30s clears it.
  HCM_BREAKER_PROBE_DEADLINE_MS: Joi.number().positive().default(30000),

  // Retry (Cycle 03)
  HCM_RETRY_MAX_ATTEMPTS: Joi.number().min(1).default(3),
  HCM_RETRY_BASE_MS: Joi.number().positive().default(100),

  // Reconciliation (Cycle 04 / 06)
  RECONCILE_INTERVAL_MS: Joi.number().positive().default(3600000),
  STUCK_STATE_THRESHOLD_MS: Joi.number().positive().default(300000),
  STUCK_STATE_SWEEP_INTERVAL_MS: Joi.number().integer().min(1000).default(60000),

  // Throttling (Cycle 07)
  THROTTLE_PER_IP_PER_MIN: Joi.number().positive().default(60),
  THROTTLE_PER_SUB_PER_MIN: Joi.number().positive().default(120),

  // Idempotency (Cycle 07)
  IDEMPOTENCY_TTL_HOURS: Joi.number().integer().min(1).default(24),

  // Mock HCM (test/dev only)
  MOCK_HCM_PORT: Joi.number().port().default(4001),
  MOCK_HCM_FIXTURE_PATH: Joi.string().default(''),
});

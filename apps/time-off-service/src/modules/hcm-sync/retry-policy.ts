/** Hard ceiling on a single backoff delay (TRD §11.3). */
export const RETRY_MAX_DELAY_MS = 5000;

/** Full-jitter fraction applied symmetrically to the computed delay (±25%, TRD §11.3). */
export const RETRY_JITTER_FRACTION = 0.25;

/** Tunable retry parameters (env-driven at the module boundary). */
export interface RetryPolicy {
  /** Number of RE-tries after the original attempt (e.g. 3 → up to 4 total calls). */
  maxAttempts: number;
  /** Base backoff for the first retry; doubled each subsequent retry. */
  baseMs: number;
}

/** Pseudo-random source in [0, 1); injected so tests can seed it deterministically. */
export type Rng = () => number;

/**
 * Computes the backoff before retry number `retryIndex` (0-based: 0 is the delay
 * before the first retry). Exponential — `base * 2^retryIndex` — capped at
 * {@link RETRY_MAX_DELAY_MS}, then full jitter of ±{@link RETRY_JITTER_FRACTION}
 * applied via `rng`. Pure: same inputs + same `rng` → same output (TRD §11.3).
 *
 * @param retryIndex zero-based retry number
 * @param baseMs base delay before the first retry
 * @param rng source of randomness in [0, 1)
 * @returns the jittered delay in milliseconds, never negative
 */
export function computeBackoffMs(retryIndex: number, baseMs: number, rng: Rng): number {
  const exponential = baseMs * 2 ** retryIndex;
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  // rng() in [0,1) → factor in [1 - f, 1 + f).
  const jitterFactor = 1 - RETRY_JITTER_FRACTION + rng() * (2 * RETRY_JITTER_FRACTION);
  return Math.max(0, capped * jitterFactor);
}

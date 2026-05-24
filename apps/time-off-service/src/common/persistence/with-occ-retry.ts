import { OccConflictError } from './occ-conflict.error';

/** Maximum attempts (original + retries) for an optimistic CAS write. TRD §10.2. */
const MAX_OCC_ATTEMPTS = 3;

/**
 * Runs an optimistic-concurrency write, retrying only on {@link OccConflictError}
 * up to {@link MAX_OCC_ATTEMPTS} times. Any other error propagates immediately.
 * When the final attempt still conflicts, the conflict is rethrown for the caller
 * to map to 409 (REQ-DEF-08). See TRD §10.2, ADR-005.
 *
 * @param op the CAS write to attempt; should re-read state and recompute on each call
 * @param maxAttempts override for the attempt cap (defaults to 3)
 * @returns the operation's result on the first non-conflicting attempt
 * @throws OccConflictError when every attempt loses the version race
 */
export async function withOccRetry<T>(
  op: () => Promise<T>,
  maxAttempts: number = MAX_OCC_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (err instanceof OccConflictError && attempt < maxAttempts) {
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error('withOccRetry: exhausted attempts without resolution');
}

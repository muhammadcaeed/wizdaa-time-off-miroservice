import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Module-level AsyncLocalStorage for per-request correlation ID propagation.
 * The `CorrelationIdMiddleware` sets the store for each request; downstream
 * code (e.g. the HCM client) reads from it without needing an HTTP reference.
 */
export const correlationStore = new AsyncLocalStorage<{ correlationId: string }>();

/** Returns the correlation ID for the current async context, or undefined outside a request. */
export function getCorrelationId(): string | undefined {
  return correlationStore.getStore()?.correlationId;
}

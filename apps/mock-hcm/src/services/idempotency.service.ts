import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** Result of an idempotency cache lookup. */
export type IdempotencyOutcome =
  | { kind: 'miss' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' };

interface CacheEntry {
  fingerprint: string;
  status: number;
  body: unknown;
}

/**
 * Tracks idempotency keys for the lifetime of the process (mock-hcm.md §6).
 * Same key + same body replays verbatim; same key + different body conflicts.
 */
@Injectable()
export class IdempotencyService {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Looks up a key against a request body.
   * @param key the Idempotency-Key header value
   * @param body the request body to fingerprint
   * @returns a miss, a verbatim replay, or a body-mismatch conflict
   */
  lookup(key: string, body: unknown): IdempotencyOutcome {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return { kind: 'miss' };
    }
    if (entry.fingerprint !== this.fingerprint(body)) {
      return { kind: 'conflict' };
    }
    return { kind: 'replay', status: entry.status, body: entry.body };
  }

  /**
   * Stores the response for a freshly executed key.
   * @param key the Idempotency-Key header value
   * @param body the request body that produced the response
   * @param status the HTTP status of the response
   * @param responseBody the response payload to replay on future hits
   * @returns nothing
   */
  store(key: string, body: unknown, status: number, responseBody: unknown): void {
    this.entries.set(key, { fingerprint: this.fingerprint(body), status, body: responseBody });
  }

  /**
   * Clears the cache.
   * @returns nothing
   */
  reset(): void {
    this.entries.clear();
  }

  /**
   * Returns the cached keys (not bodies) for state inspection.
   * @returns the list of stored keys
   */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  private fingerprint(body: unknown): string {
    return createHash('sha256').update(canonicalize(body)).digest('hex');
  }
}

/** Canonical JSON with sorted object keys, so field order doesn't matter. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

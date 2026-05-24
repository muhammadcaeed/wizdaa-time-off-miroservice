import { Injectable } from '@nestjs/common';

/** A single recorded HCM-surface call (mock-hcm.md §3.6). */
export interface CallLogEntry {
  method: string;
  path: string;
  body: unknown;
  headers: { 'idempotency-key'?: string };
  status: number;
  /** True when the connection was destroyed before a status was sent. */
  transport_error?: boolean;
  timestamp: string;
}

/** Default ring-buffer capacity for the call log (mock-hcm.md §3.6). */
const DEFAULT_CALL_LOG_LIMIT = 100;

/**
 * Records the last N HCM-surface calls so contract and chaos tests can assert
 * what the client sent — e.g. that the same Idempotency-Key was used on every
 * retry attempt (mock-hcm.md §3.6). Process-local; cleared by the control
 * plane's reset.
 */
@Injectable()
export class CallLogService {
  private entries: CallLogEntry[] = [];
  private readonly limit = DEFAULT_CALL_LOG_LIMIT;

  /**
   * Appends a call, evicting the oldest entry past the buffer limit.
   * @param entry the call to record
   * @returns nothing
   */
  record(entry: CallLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.shift();
    }
  }

  /**
   * Returns the recorded calls, oldest first.
   * @returns a copy of the call log
   */
  list(): CallLogEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Clears the call log.
   * @returns nothing
   */
  reset(): void {
    this.entries = [];
  }
}

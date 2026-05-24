import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';

/** A single stored balance row, keyed by (employee_id, location_id). */
export interface BalanceRow {
  employee_id: string;
  location_id: string;
  total_days: number;
  last_modified_at: string;
}

/** One page of a batch query (mock-hcm.md §2.3, api-contract.md §5). */
export interface BatchPage {
  rows: BalanceRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Decoded opaque batch cursor: the sort tuple of the last emitted row. */
interface BatchCursor {
  v: 1;
  t: string;
  k: string;
}

/** Cursor envelope version, embedded so the encoding can evolve (api-contract.md §5). */
const BATCH_CURSOR_VERSION = 1;

/** Maximum page size for the batch endpoint; larger requests are clamped (api-contract.md §5). */
const MAX_BATCH_LIMIT = 100;

// Anchored at the repo root (cwd for every npm/vitest invocation) rather than
// __dirname: the compiled `nest start mock-hcm` runs from dist/, where the
// source's `src/` segment is gone, so a __dirname-relative path overshoots to
// dist/apps/fixtures and ENOENTs. The source tree path is stable from cwd.
const DEFAULT_FIXTURE_PATH = resolve(process.cwd(), 'apps/mock-hcm/fixtures/balances.json');

/**
 * In-memory balance store seeded from a JSON fixture (mock-hcm.md §5).
 * Process-local; reset between tests via the control plane.
 */
@Injectable()
export class StorageService {
  private readonly rows = new Map<string, BalanceRow>();

  constructor() {
    this.reset();
  }

  /**
   * Re-seeds storage from the fixture, discarding all current rows.
   * @returns nothing
   */
  reset(): void {
    this.rows.clear();
    for (const row of this.loadFixture()) {
      this.rows.set(this.key(row.employee_id, row.location_id), { ...row });
    }
  }

  /**
   * Finds the balance row for a single (employee, location) pair.
   * @param employeeId employee identifier
   * @param locationId location identifier
   * @returns the row, or undefined if the pair is unknown
   */
  find(employeeId: string, locationId: string): BalanceRow | undefined {
    return this.rows.get(this.key(employeeId, locationId));
  }

  /**
   * Returns every balance row for an employee, one per location.
   * @param employeeId employee identifier
   * @returns the matching rows (empty if the employee is unknown)
   */
  findByEmployee(employeeId: string): BalanceRow[] {
    return this.snapshot().filter((row) => row.employee_id === employeeId);
  }

  /**
   * Inserts or overwrites a balance row.
   * @param row the row to store
   * @returns nothing
   */
  upsert(row: BalanceRow): void {
    this.rows.set(this.key(row.employee_id, row.location_id), { ...row });
  }

  /**
   * Applies a delta to a stored total and refreshes last_modified_at.
   * @param employeeId employee identifier
   * @param locationId location identifier
   * @param delta signed change to apply
   * @returns the new total_days
   * @throws Error if the pair is unknown
   */
  applyDelta(employeeId: string, locationId: string, delta: number): number {
    const row = this.find(employeeId, locationId);
    if (row === undefined) {
      throw new Error(`Unknown balance for ${this.key(employeeId, locationId)}`);
    }
    const updated: BalanceRow = {
      ...row,
      total_days: row.total_days + delta,
      last_modified_at: new Date().toISOString(),
    };
    this.rows.set(this.key(employeeId, locationId), updated);
    return updated.total_days;
  }

  /**
   * Silently overwrites a stored total WITHOUT touching last_modified_at, so the
   * batch `since` filter will not surface the change (mock-hcm.md §3.3). Models an
   * HCM-side edit the service must catch via the post-commit drift check, not via
   * reconciliation.
   * @param employeeId employee identifier
   * @param locationId location identifier
   * @param totalDays the new absolute total
   * @returns the new total_days
   * @throws Error if the pair is unknown
   */
  drift(employeeId: string, locationId: string, totalDays: number): number {
    const row = this.find(employeeId, locationId);
    if (row === undefined) {
      throw new Error(`Unknown balance for ${this.key(employeeId, locationId)}`);
    }
    // Preserve last_modified_at: that omission is the whole point of drift.
    this.rows.set(this.key(employeeId, locationId), { ...row, total_days: totalDays });
    return totalDays;
  }

  /**
   * Returns one page of rows modified at or after `since`, ordered by
   * (last_modified_at, key) ascending for stable cursor pagination
   * (mock-hcm.md §2.3, api-contract.md §5).
   * @param since lower bound (inclusive) on last_modified_at
   * @param afterCursor opaque cursor; resume strictly after its tuple, or start
   *   from the beginning when undefined
   * @param limit requested page size; clamped to [1, {@link MAX_BATCH_LIMIT}]
   * @returns the page rows plus the next cursor and a has-more flag
   * @throws Error if the cursor is malformed
   */
  batchSince(since: Date, afterCursor: string | undefined, limit: number): BatchPage {
    const cursor = afterCursor === undefined ? undefined : this.decodeCursor(afterCursor);
    const effectiveLimit = Math.min(Math.max(1, limit), MAX_BATCH_LIMIT);

    const candidates = this.snapshot()
      .filter((row) => new Date(row.last_modified_at).getTime() >= since.getTime())
      .filter((row) => cursor === undefined || this.isAfter(row, cursor))
      .sort((a, b) => this.compareSort(a, b));

    // Fetch one extra: if it exists the page is full and more remain. Slicing
    // collapses has_more=false and next_cursor=null when the result exactly drains.
    const window = candidates.slice(0, effectiveLimit + 1);
    const hasMore = window.length > effectiveLimit;
    const rows = window.slice(0, effectiveLimit);
    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last !== undefined ? this.encodeCursor(last) : null;

    return { rows, nextCursor, hasMore };
  }

  /**
   * Returns a copy of every stored row for state inspection.
   * @returns all stored balance rows
   */
  snapshot(): BalanceRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  /** Total order: last_modified_at first, then key, both ascending. */
  private compareSort(a: BalanceRow, b: BalanceRow): number {
    if (a.last_modified_at !== b.last_modified_at) {
      return a.last_modified_at < b.last_modified_at ? -1 : 1;
    }
    const ka = this.key(a.employee_id, a.location_id);
    const kb = this.key(b.employee_id, b.location_id);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  /** True when `row` sorts strictly after the cursor tuple. */
  private isAfter(row: BalanceRow, cursor: BatchCursor): boolean {
    if (row.last_modified_at !== cursor.t) {
      return row.last_modified_at > cursor.t;
    }
    return this.key(row.employee_id, row.location_id) > cursor.k;
  }

  private encodeCursor(row: BalanceRow): string {
    const payload: BatchCursor = {
      v: BATCH_CURSOR_VERSION,
      t: row.last_modified_at,
      k: this.key(row.employee_id, row.location_id),
    };
    return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
  }

  private decodeCursor(raw: string): BatchCursor {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    } catch {
      throw new Error('Malformed batch cursor');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as BatchCursor).v !== BATCH_CURSOR_VERSION ||
      typeof (parsed as BatchCursor).t !== 'string' ||
      typeof (parsed as BatchCursor).k !== 'string'
    ) {
      throw new Error('Malformed batch cursor');
    }
    return parsed as BatchCursor;
  }

  private loadFixture(): BalanceRow[] {
    // `||` not `??`: an empty string (e.g. the main service's Joi default for
    // this var) means "unset" and must fall back to the bundled fixture.
    const path = process.env.MOCK_HCM_FIXTURE_PATH || DEFAULT_FIXTURE_PATH;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as BalanceRow[];
  }
}

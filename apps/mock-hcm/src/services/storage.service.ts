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
   * Returns a copy of every stored row for state inspection.
   * @returns all stored balance rows
   */
  snapshot(): BalanceRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  private loadFixture(): BalanceRow[] {
    // `||` not `??`: an empty string (e.g. the main service's Joi default for
    // this var) means "unset" and must fall back to the bundled fixture.
    const path = process.env.MOCK_HCM_FIXTURE_PATH || DEFAULT_FIXTURE_PATH;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as BalanceRow[];
  }
}

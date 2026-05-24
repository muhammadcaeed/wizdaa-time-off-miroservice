import type { Balance } from '../../../database/entities';

/** One balance row as returned to clients (snake_case API surface). */
export interface BalanceView {
  location_id: string;
  total_days: number;
  reserved_days: number;
  available_days: number;
  last_hcm_sync_at: string | null;
}

/** Balance read response: all of an employee's balances (REQ-BAL-01, §4.2). */
export interface BalanceResponse {
  employee_id: string;
  balances: BalanceView[];
}

/** Maps persisted balances to the API view, computing `available_days`. */
export function toBalanceResponse(employeeId: string, balances: Balance[]): BalanceResponse {
  return {
    employee_id: employeeId,
    balances: balances.map((b) => ({
      location_id: b.locationId,
      total_days: b.totalDays,
      reserved_days: b.reservedDays,
      available_days: b.totalDays - b.reservedDays,
      last_hcm_sync_at: b.lastHcmSyncAt ? b.lastHcmSyncAt.toISOString() : null,
    })),
  };
}

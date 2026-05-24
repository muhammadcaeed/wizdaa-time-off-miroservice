import type { TimeOffRequest } from '../../../database/entities';

/** A request as returned to clients (snake_case API surface). */
export interface RequestResponse {
  id: string;
  employee_id: string;
  location_id: string;
  start_date: string;
  end_date: string;
  days_requested: number;
  status: string;
  submitted_at: string;
  decided_at: string | null;
  hcm_correlation_id: string | null;
  failure_reason: string | null;
}

export function toRequestResponse(r: TimeOffRequest): RequestResponse {
  return {
    id: r.id,
    employee_id: r.employeeId,
    location_id: r.locationId,
    start_date: r.startDate,
    end_date: r.endDate,
    days_requested: r.daysRequested,
    status: r.status,
    submitted_at:
      r.submittedAt instanceof Date ? r.submittedAt.toISOString() : String(r.submittedAt),
    decided_at: r.decidedAt instanceof Date ? r.decidedAt.toISOString() : (r.decidedAt ?? null),
    hcm_correlation_id: r.hcmCorrelationId ?? null,
    failure_reason: r.failureReason ?? null,
  };
}

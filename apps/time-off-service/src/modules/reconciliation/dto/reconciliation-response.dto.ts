import type {
  Reconciliation,
  ReconciliationStatus,
  ReconciliationTrigger,
} from '../../../database/entities/reconciliation.entity';

/** One reconciliation run as returned to admins (snake_case API surface, api-contract.md §2). */
export interface ReconciliationResponse {
  id: string;
  status: ReconciliationStatus;
  since: string;
  started_at: string;
  completed_at: string | null;
  balances_examined: number;
  conflicts: number;
  trigger_type: ReconciliationTrigger;
}

/** A cursor page of reconciliation runs (api-contract.md §5). */
export interface ReconciliationListResponse {
  data: ReconciliationResponse[];
  pagination: { next_cursor: string | null; has_more: boolean };
}

/**
 * Maps a persisted run to its API view.
 * @param run the persisted reconciliation run
 * @returns the snake_case response resource
 */
export function toReconciliationResponse(run: Reconciliation): ReconciliationResponse {
  return {
    id: run.id,
    status: run.status,
    since: run.since.toISOString(),
    started_at: run.startedAt.toISOString(),
    completed_at: run.completedAt ? run.completedAt.toISOString() : null,
    balances_examined: run.balancesExamined,
    conflicts: run.conflicts,
    trigger_type: run.triggerType,
  };
}

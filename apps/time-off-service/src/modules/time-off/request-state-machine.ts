import type { RequestStatus } from '../../database/entities';

export type { RequestStatus };

/**
 * Allowed transitions per TRD §5.1. The status-predicate CAS in
 * {@link RequestRepository.casStatus} is the atomic enforcer; this map lets the
 * service pick and validate a target state before the write.
 */
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  SUBMITTED: ['APPROVING', 'REJECTED', 'CANCELLED'],
  APPROVING: ['APPROVED', 'APPROVAL_FAILED'],
  APPROVED: ['CANCELLING'],
  APPROVAL_FAILED: ['APPROVING', 'CANCELLED'],
  REJECTED: [],
  CANCELLING: ['CANCELLED', 'CANCELLATION_FAILED'],
  CANCELLATION_FAILED: ['CANCELLING'],
  CANCELLED: [],
};

/** True when `from → to` is a legal lifecycle transition. */
export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

import { canTransition } from './request-state-machine';

/**
 * @req REQ-LIFE-03
 * @req REQ-LIFE-16
 */
describe('request state machine (TRD §5.1)', () => {
  it('allows the approval-saga forward transitions', () => {
    expect(canTransition('SUBMITTED', 'APPROVING')).toBe(true);
    expect(canTransition('APPROVING', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVING', 'APPROVAL_FAILED')).toBe(true);
  });

  it('allows the terminal pre-approval transitions', () => {
    expect(canTransition('SUBMITTED', 'REJECTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'CANCELLED')).toBe(true);
  });

  it('rejects approving a request that is not SUBMITTED', () => {
    expect(canTransition('APPROVED', 'APPROVING')).toBe(false);
    expect(canTransition('APPROVAL_FAILED', 'APPROVED')).toBe(false);
  });

  it('rejects transitions to the same state and unknown jumps', () => {
    expect(canTransition('SUBMITTED', 'SUBMITTED')).toBe(false);
    expect(canTransition('APPROVED', 'SUBMITTED')).toBe(false);
  });
});

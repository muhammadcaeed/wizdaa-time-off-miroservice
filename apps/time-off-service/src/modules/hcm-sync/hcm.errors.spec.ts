import {
  HcmArithmeticMismatchError,
  HcmBreakerOpenError,
  HcmError,
  HcmInsufficientBalanceError,
  HcmServerError,
  HcmTimeoutError,
  HcmTransportError,
} from './hcm.errors';

/**
 * The error taxonomy is the foundation of the resilience policy (ADR-008): the
 * retry loop and breaker read `retryable` / `countsTowardBreaker` rather than
 * branching on instanceof.
 *
 * @req REQ-SYNC-06
 * @req REQ-SYNC-07
 */
describe('HCM error taxonomy (ADR-008, TRD §11.1/§11.2)', () => {
  it('F-01 network: hcm_unreachable, retryable, counts toward breaker', () => {
    const e = new HcmTransportError('x');
    expect(e.reason).toBe('hcm_unreachable');
    expect(e.retryable).toBe(true);
    expect(e.countsTowardBreaker).toBe(true);
  });

  it('F-02 timeout: hcm_timeout, retryable, counts toward breaker', () => {
    const e = new HcmTimeoutError('x');
    expect(e.reason).toBe('hcm_timeout');
    expect(e.retryable).toBe(true);
    expect(e.countsTowardBreaker).toBe(true);
  });

  it('F-03 5xx: hcm_server_error, retryable, counts toward breaker', () => {
    const e = new HcmServerError('x');
    expect(e.reason).toBe('hcm_server_error');
    expect(e.retryable).toBe(true);
    expect(e.countsTowardBreaker).toBe(true);
  });

  it('F-04 ambiguous: hcm_ambiguous, NOT retryable, counts toward breaker', () => {
    const e = new HcmArithmeticMismatchError('x');
    expect(e.reason).toBe('hcm_ambiguous');
    expect(e.retryable).toBe(false);
    expect(e.countsTowardBreaker).toBe(true);
  });

  it('F-05 insufficient balance: hcm_insufficient_balance, NOT retryable, does NOT count', () => {
    const e = new HcmInsufficientBalanceError('x');
    expect(e.reason).toBe('hcm_insufficient_balance');
    expect(e.retryable).toBe(false);
    expect(e.countsTowardBreaker).toBe(false);
  });

  it('breaker-open signal is NOT an HcmError so the saga catch cannot swallow it', () => {
    const e = new HcmBreakerOpenError();
    expect(e).not.toBeInstanceOf(HcmError);
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe('hcm_unavailable');
  });
});

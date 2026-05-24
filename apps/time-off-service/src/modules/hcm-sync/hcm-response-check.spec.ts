import { HcmArithmeticMismatchError } from './hcm.errors';
import { verifyAdjustResponse } from './hcm-response-check';

/**
 * @req REQ-SYNC-03
 * @req REQ-SYNC-04
 */
describe('verifyAdjustResponse (expected-total arithmetic check, TRD §9.4)', () => {
  it('accepts a 2xx response whose new_total_days equals pre_total + delta with a correlation id', () => {
    const result = verifyAdjustResponse(
      { new_total_days: 15, hcm_correlation_id: 'hcm_op_1' },
      20,
      -5,
    );
    expect(result).toEqual({ newTotalDays: 15, correlationId: 'hcm_op_1' });
  });

  it('throws when new_total_days disagrees with pre_total + delta (F-04)', () => {
    expect(() =>
      verifyAdjustResponse({ new_total_days: 16, hcm_correlation_id: 'hcm_op_1' }, 20, -5),
    ).toThrow(HcmArithmeticMismatchError);
  });

  it('throws when the correlation id is missing or empty', () => {
    expect(() =>
      verifyAdjustResponse({ new_total_days: 15, hcm_correlation_id: '' }, 20, -5),
    ).toThrow(HcmArithmeticMismatchError);
    expect(() => verifyAdjustResponse({ new_total_days: 15 }, 20, -5)).toThrow(
      HcmArithmeticMismatchError,
    );
  });

  it('throws when new_total_days is not a number', () => {
    expect(() =>
      verifyAdjustResponse({ new_total_days: 'oops', hcm_correlation_id: 'x' }, 20, -5),
    ).toThrow(HcmArithmeticMismatchError);
  });
});

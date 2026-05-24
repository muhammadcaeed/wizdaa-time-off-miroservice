import { HcmArithmeticMismatchError } from './hcm.errors';

/** A verified adjust outcome the saga can commit against. */
export interface VerifiedAdjust {
  newTotalDays: number;
  correlationId: string;
}

/**
 * The expected-total arithmetic check (TRD §9.4 item 2, the commit gate). A 2xx
 * adjust commits only if it carries a non-empty `hcm_correlation_id` and
 * `new_total_days === preTotal + delta`. Any deviation is F-04 (ambiguous) and
 * throws {@link HcmArithmeticMismatchError}; the saga then fails the request
 * rather than committing a state it can't trust (REQ-SYNC-03, REQ-SYNC-04).
 *
 * @param body the parsed adjust response
 * @param preTotal the local total captured before the call
 * @param delta the signed adjustment (negative for decrement)
 */
export function verifyAdjustResponse(
  body: { new_total_days?: unknown; hcm_correlation_id?: unknown },
  preTotal: number,
  delta: number,
): VerifiedAdjust {
  const correlationId = body.hcm_correlation_id;
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    throw new HcmArithmeticMismatchError('HCM response missing hcm_correlation_id');
  }

  const expected = preTotal + delta;
  const newTotalDays = body.new_total_days;
  if (typeof newTotalDays !== 'number') {
    throw new HcmArithmeticMismatchError('HCM response new_total_days is not a number', expected);
  }

  if (newTotalDays !== expected) {
    throw new HcmArithmeticMismatchError(
      `HCM new_total_days ${newTotalDays} disagrees with expected ${expected} (pre ${preTotal}, delta ${delta})`,
      expected,
      newTotalDays,
      correlationId,
    );
  }

  return { newTotalDays, correlationId };
}

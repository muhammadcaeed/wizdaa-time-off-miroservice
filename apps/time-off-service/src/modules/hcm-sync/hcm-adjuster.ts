import type { AdjustBalanceInput } from './hcm-client';
import type { VerifiedAdjust } from './hcm-response-check';

/** DI token for the {@link HcmAdjuster} abstraction. */
export const HCM_ADJUSTER = Symbol('HCM_ADJUSTER');

/**
 * The narrow HCM capability the sagas depend on (ISP/DIP). {@link HcmClient}
 * implements it; tests substitute a fake. Keeping the saga off the concrete
 * client lets the retry/breaker decorator (ADR-008) slot in later without
 * touching saga code.
 */
export interface HcmAdjuster {
  adjustBalance(input: AdjustBalanceInput): Promise<VerifiedAdjust>;
}

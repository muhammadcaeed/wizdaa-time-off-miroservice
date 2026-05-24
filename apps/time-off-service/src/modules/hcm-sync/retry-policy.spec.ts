import { computeBackoffMs, RETRY_MAX_DELAY_MS } from './retry-policy';

/**
 * @req REQ-SYNC-07
 */
describe('computeBackoffMs (exponential backoff + full jitter, TRD §11.3)', () => {
  const BASE = 100;

  it('doubles the base each retry: 100, 200, 400 (mid jitter = no change)', () => {
    const midRng = () => 0.5; // factor = 1.0
    expect(computeBackoffMs(0, BASE, midRng)).toBe(100);
    expect(computeBackoffMs(1, BASE, midRng)).toBe(200);
    expect(computeBackoffMs(2, BASE, midRng)).toBe(400);
  });

  it('applies the lower jitter bound (rng→0 ⇒ -25%)', () => {
    const lowRng = () => 0;
    expect(computeBackoffMs(0, BASE, lowRng)).toBe(75);
    expect(computeBackoffMs(2, BASE, lowRng)).toBe(300);
  });

  it('applies the upper jitter bound (rng→~1 ⇒ +25%)', () => {
    const highRng = () => 0.999999;
    expect(computeBackoffMs(0, BASE, highRng)).toBeCloseTo(125, 3);
    expect(computeBackoffMs(2, BASE, highRng)).toBeCloseTo(500, 3);
  });

  it('keeps every jittered delay within ±25% of the exponential value', () => {
    for (let r = 0; r < 6; r++) {
      const exponential = Math.min(BASE * 2 ** r, RETRY_MAX_DELAY_MS);
      for (const u of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const d = computeBackoffMs(r, BASE, () => u);
        expect(d).toBeGreaterThanOrEqual(exponential * 0.75 - 1e-6);
        expect(d).toBeLessThanOrEqual(exponential * 1.25 + 1e-6);
      }
    }
  });

  it('caps the exponential term at 5000ms before jitter', () => {
    // 100 * 2^7 = 12800 → capped to 5000; mid jitter leaves it at 5000.
    expect(computeBackoffMs(7, BASE, () => 0.5)).toBe(RETRY_MAX_DELAY_MS);
    // Upper jitter is applied to the cap, not the uncapped value.
    expect(computeBackoffMs(7, BASE, () => 0.999999)).toBeLessThanOrEqual(
      RETRY_MAX_DELAY_MS * 1.25 + 1e-6,
    );
  });
});

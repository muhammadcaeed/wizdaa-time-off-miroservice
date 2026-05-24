import type { HcmAdjuster } from './hcm-adjuster';
import { verifyAdjustResponse, type VerifiedAdjust } from './hcm-response-check';
import { HcmInsufficientBalanceError, HcmTransportError } from './hcm.errors';

/** Arguments for a balance adjustment (decrement on approval, increment on cancel). */
export interface AdjustBalanceInput {
  employeeId: string;
  locationId: string;
  /** Signed days; negative = decrement (DECREMENT), positive = increment (INCREMENT). */
  delta: number;
  /** `<request_id>:<operation_type>` (ADR-007). Reused verbatim across retries. */
  idempotencyKey: string;
  /** Local total captured before the call; the arithmetic check compares against `preTotal + delta`. */
  expectedPreTotal: number;
  sourceReference: string;
}

/**
 * Typed client for the HCM realtime adjust endpoint (TRD §9.1). Wraps native
 * `fetch` — the wrapper earns its place by enforcing the expected-total
 * arithmetic check (TRD §9.4 item 2) and mapping HCM outcomes to typed
 * {@link HcmError}s the saga can branch on. Retry and circuit breaker (ADR-008)
 * are layered on in a later cycle; this cycle makes a single attempt.
 */
export class HcmClient implements HcmAdjuster {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Adjusts an HCM balance and verifies the response.
   * @returns the verified new total and HCM correlation id
   * @throws HcmInsufficientBalanceError on HCM 409 (F-05, not retryable)
   * @throws HcmArithmeticMismatchError when the 2xx response is inconsistent (F-04)
   * @throws HcmTransportError on network failure, timeout, or 5xx (F-01/02/03)
   */
  async adjustBalance(input: AdjustBalanceInput): Promise<VerifiedAdjust> {
    const operationType = input.delta < 0 ? 'DECREMENT' : 'INCREMENT';
    const response = await this.post(
      {
        employee_id: input.employeeId,
        location_id: input.locationId,
        delta: input.delta,
        operation_type: operationType,
        source_reference: input.sourceReference,
      },
      input.idempotencyKey,
    );

    if (response.status === 409) {
      throw new HcmInsufficientBalanceError('HCM rejected the adjustment: insufficient balance');
    }
    if (!response.ok) {
      throw new HcmTransportError(`HCM adjust returned ${response.status}`);
    }

    const body = (await this.parseJson(response)) as {
      new_total_days?: unknown;
      hcm_correlation_id?: unknown;
    };
    return verifyAdjustResponse(body, input.expectedPreTotal, input.delta);
  }

  private async post(body: unknown, idempotencyKey: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}/hcm/balances/adjust`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure or timeout (abort) — the outcome is unknown (F-01/F-02).
      throw new HcmTransportError(
        err instanceof Error
          ? `HCM adjust transport failure: ${err.message}`
          : 'HCM adjust transport failure',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new HcmTransportError('HCM adjust returned an unparseable body');
    }
  }
}

import { getCorrelationId } from '../../common/context/correlation.context';
import type { HcmAdjuster } from './hcm-adjuster';
import { verifyAdjustResponse, type VerifiedAdjust } from './hcm-response-check';
import {
  HcmInsufficientBalanceError,
  HcmServerError,
  HcmTimeoutError,
  HcmTransportError,
} from './hcm.errors';

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
 * arithmetic check (TRD §9.2 item 2) and mapping HCM outcomes to typed
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
   * @throws HcmServerError on HCM 5xx or an unparseable body (F-03)
   * @throws HcmTimeoutError when the client timeout aborted the request (F-02)
   * @throws HcmTransportError on network failure (F-01)
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
      // 5xx is F-03 (retryable server error); any other non-2xx that reaches
      // here (after the 409 branch) is treated the same defensively.
      throw new HcmServerError(`HCM adjust returned ${response.status}`);
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
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          ...(getCorrelationId() ? { 'x-correlation-id': getCorrelationId() as string } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // The AbortController fired our timeout — distinguish F-02 (timeout) from
      // F-01 (network). fetch surfaces an abort as an AbortError / aborted signal.
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new HcmTimeoutError(`HCM adjust timed out after ${this.timeoutMs}ms`);
      }
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
      // A 2xx with a body we can't parse is server-side misbehavior (F-03).
      throw new HcmServerError('HCM adjust returned an unparseable body');
    }
  }
}

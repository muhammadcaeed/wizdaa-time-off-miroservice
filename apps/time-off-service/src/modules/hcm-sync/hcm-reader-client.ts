import type { HcmBalanceRow, HcmBatchPage, HcmReader } from './hcm-reader';
import { HcmServerError, HcmTimeoutError, HcmTransportError } from './hcm.errors';

/** HTTP status HCM returns when an employee is unknown; treated as "no balances". */
const STATUS_NOT_FOUND = 404;

/**
 * Typed read-only client for the HCM balance surface (TRD §9.1), parallel to
 * {@link HcmClient} on the write side. Wraps native `fetch` with the same
 * AbortController timeout and failure-mode mapping (F-01/F-02/F-03), and
 * normalizes HCM's snake_case payloads into {@link HcmBalanceRow}s. It is a
 * plain client: retry and circuit-breaker gating of reads are the consumer's
 * responsibility (a later sub-task), not baked in here.
 */
export class HcmReaderClient implements HcmReader {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Reads every balance row HCM holds for one employee (GET /hcm/balances/:id).
   * @param employeeId the employee to read
   * @returns the employee's balance rows; an empty array on HCM 404
   * @throws HcmServerError on HCM 5xx or an unparseable body (F-03)
   * @throws HcmTimeoutError when the client timeout aborted the request (F-02)
   * @throws HcmTransportError on network failure (F-01)
   */
  async getBalances(employeeId: string): Promise<HcmBalanceRow[]> {
    const response = await this.get(`/hcm/balances/${employeeId}`);

    // An unknown employee (404) is "nothing to reconcile", not a fault: point
    // reconciliation treats a missing HCM employee as "no drift" and must not
    // throw. Distinct from a 5xx, which is a genuine server-side failure (F-03).
    if (response.status === STATUS_NOT_FOUND) {
      return [];
    }
    if (!response.ok) {
      throw new HcmServerError(`HCM get-balances returned ${response.status}`);
    }

    const body = (await this.parseJson(response, 'get-balances')) as { balances?: unknown };
    const balances = Array.isArray(body.balances) ? body.balances : [];
    return balances.map((entry) => {
      const row = entry as {
        location_id?: unknown;
        total_days?: unknown;
        last_modified_at?: unknown;
      };
      return {
        employeeId,
        locationId: String(row.location_id),
        totalDays: Number(row.total_days),
        lastModifiedAt: String(row.last_modified_at),
      };
    });
  }

  /**
   * Reads one page of balances modified at or after `since` (GET /hcm/balances/batch).
   * @param since lower bound (inclusive) on last_modified_at
   * @param cursor opaque cursor from a prior page's `nextCursor`; omit to start fresh
   * @returns the page rows plus the next cursor and a has-more flag
   * @throws HcmServerError on HCM 5xx, a 400 (service-generated cursor is a bug,
   *   not a transient fault), or an unparseable body
   * @throws HcmTimeoutError when the client timeout aborted the request (F-02)
   * @throws HcmTransportError on network failure (F-01)
   */
  async getBatch(since: Date, cursor?: string): Promise<HcmBatchPage> {
    const params = new URLSearchParams({ since: since.toISOString() });
    if (cursor !== undefined) {
      params.set('cursor', cursor);
    }
    const response = await this.get(`/hcm/balances/batch?${params.toString()}`);

    // A 400 means the cursor we sent is malformed. The service generates every
    // cursor, so a 400 is a programming error, not a transient HCM fault — map
    // it to HcmServerError defensively rather than letting it pass as success.
    if (!response.ok) {
      throw new HcmServerError(`HCM batch returned ${response.status}`);
    }

    const body = (await this.parseJson(response, 'batch')) as {
      data?: unknown;
      pagination?: { next_cursor?: unknown; has_more?: unknown };
    };
    const data = Array.isArray(body.data) ? body.data : [];
    const rows: HcmBalanceRow[] = data.map((entry) => {
      const row = entry as {
        employee_id?: unknown;
        location_id?: unknown;
        total_days?: unknown;
        last_modified_at?: unknown;
      };
      return {
        employeeId: String(row.employee_id),
        locationId: String(row.location_id),
        totalDays: Number(row.total_days),
        lastModifiedAt: String(row.last_modified_at),
      };
    });
    const nextCursor =
      typeof body.pagination?.next_cursor === 'string' ? body.pagination.next_cursor : null;
    const hasMore = body.pagination?.has_more === true;
    return { rows, nextCursor, hasMore };
  }

  private async get(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      // The AbortController fired our timeout — distinguish F-02 (timeout) from
      // F-01 (network). fetch surfaces an abort as an AbortError / aborted signal.
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new HcmTimeoutError(`HCM read timed out after ${this.timeoutMs}ms`);
      }
      throw new HcmTransportError(
        err instanceof Error
          ? `HCM read transport failure: ${err.message}`
          : 'HCM read transport failure',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson(response: Response, op: string): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      // A 2xx with a body we can't parse is server-side misbehavior (F-03).
      throw new HcmServerError(`HCM ${op} returned an unparseable body`);
    }
  }
}

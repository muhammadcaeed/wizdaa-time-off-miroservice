/** DI token for the {@link HcmReader} abstraction. */
export const HCM_READER = Symbol('HCM_READER');

/** A single HCM balance row, normalized to the service's camelCase shape (TRD §9.1). */
export interface HcmBalanceRow {
  employeeId: string;
  locationId: string;
  totalDays: number;
  lastModifiedAt: string;
}

/** One page of a batch read: the rows plus the opaque cursor to resume after (TRD §9.1). */
export interface HcmBatchPage {
  rows: HcmBalanceRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The narrow read capability consumers depend on (ISP/DIP), parallel to
 * {@link HcmAdjuster}. {@link HcmReaderClient} implements it; tests substitute a
 * fake. Reconciliation (point reads, TRD §9.3) and the change-sweep (batch
 * reads, TRD §9.7) depend only on this token, so the breaker-gating decorator
 * (a later sub-task) can wrap it without touching consumer code.
 */
export interface HcmReader {
  /**
   * Reads every balance row HCM holds for one employee (GET /hcm/balances/:id).
   * @param employeeId the employee to read
   * @returns the employee's balance rows; an empty array when HCM does not know
   *   the employee (404) — an unknown employee is "no drift", never an error
   * @throws HcmServerError on HCM 5xx or an unparseable body (F-03)
   * @throws HcmTimeoutError when the client timeout aborted the request (F-02)
   * @throws HcmTransportError on network failure (F-01)
   */
  getBalances(employeeId: string): Promise<HcmBalanceRow[]>;

  /**
   * Reads one page of balances modified at or after `since`, ordered for stable
   * cursor pagination (GET /hcm/balances/batch).
   * @param since lower bound (inclusive) on last_modified_at
   * @param cursor opaque cursor from a prior page's `nextCursor`; omit to start
   *   from the beginning
   * @returns the page rows plus the next cursor and a has-more flag
   * @throws HcmServerError on HCM 5xx, a 400 (a cursor the service generated is
   *   malformed = a bug, not a transient fault), or an unparseable body
   * @throws HcmTimeoutError when the client timeout aborted the request (F-02)
   * @throws HcmTransportError on network failure (F-01)
   */
  getBatch(since: Date, cursor?: string): Promise<HcmBatchPage>;
}

# HCM Integration

Companion to `TRD.md` §9. The TRD covers the sync model, defensive behaviors, and conflict-resolution rules at the decision level. This file is the implementer's reference: full HCM contract shapes, reconciliation pseudocode, point-reconciliation pseudocode, the rationale behind the expected-total arithmetic check, multi-writer acknowledgment, and the soft points in the assumed contract.

## 1. Assumed HCM contract

The HCM exposes three endpoints. The service treats the shapes below as the integration interface. The mock HCM (`mock-hcm.md`) implements this contract faithfully so the production HCM client never observes "this works against the mock but not the real one."

### 1.1 `GET /hcm/balances/:employee_id` — realtime read

Returns all balances for the employee, one row per location.

```json
{
  "employee_id": "emp_abc",
  "balances": [
    { "location_id": "loc_xyz", "total_days": 18, "last_modified_at": "2026-05-22T09:14:00Z" }
  ]
}
```

Status: 200 success, 404 employee unknown to HCM, 5xx server error.

### 1.2 `POST /hcm/balances/adjust` — realtime adjustment, idempotent

Request:

```json
{
  "employee_id": "emp_abc",
  "location_id": "loc_xyz",
  "delta": -5,
  "operation_type": "DECREMENT",
  "source_reference": "request:req_123"
}
```

Header: `Idempotency-Key: req_123:decrement` (key construction per ADR-007).

Response:

```json
{
  "employee_id": "emp_abc",
  "location_id": "loc_xyz",
  "new_total_days": 13,
  "hcm_correlation_id": "hcm_op_456",
  "timestamp": "2026-05-24T15:30:00Z"
}
```

Status: 200 success, 409 insufficient balance, 422 invalid combination, 5xx server error. A duplicate request with the same key is expected to return the original response. The service treats this guarantee as soft; see §6.

### 1.3 `GET /hcm/balances/batch?since=<iso8601>&cursor=<opaque>` — paginated corpus

Returns balances modified at or after the `since` timestamp. Used by reconciliation. Row shape matches the realtime read. Pagination follows the cursor convention in `api-contract.md` §5.

The `since` semantics (strictly-greater-than vs greater-than-or-equal) need verification with the vendor; the reconciliation algorithm below assumes strictly-greater-than.

---

## 2. Reconciliation algorithm (batch)

Conflict-resolution rules and the high-level behavior are in TRD §9.3. The pseudocode below shows the exact loop, transaction boundary, and audit-write semantics.

```
function reconcile(since):
  run = Reconciliation.create(status="RUNNING", started_at=now())
  cursor = null
  loop:
    page = HCM.batch(since, cursor)
    for each (employee_id, location_id, hcm_total_days) in page.data:
      transaction:
        local = Balance.find_or_create(employee_id, location_id)
        if hcm_total_days == local.total_days:
          local.last_hcm_sync_at = now()
          continue
        # drift detected
        reserved = sum(TimeOffRequest.days_requested
                       where matches (employee_id, location_id)
                       and status in (SUBMITTED, APPROVING, CANCELLING))
        if hcm_total_days - reserved >= 0:
          local.total_days = hcm_total_days
          local.reserved_days = reserved
          local.version += 1
          local.last_hcm_sync_at = now()
          AuditLog.append("balance.reconciled", before, after, run.id)
        else:
          # HCM total can't support existing reservations
          AuditLog.append("balance.reconciliation.conflict",
                          metadata={hcm_total_days, reserved}, run.id)
          run.conflicts += 1
    cursor = page.pagination.next_cursor
    if not page.pagination.has_more: break
  run.status = "COMPLETED" if run.conflicts == 0 else "COMPLETED_WITH_CONFLICTS"
  run.completed_at = now()
```

Properties:

- **Idempotent**: re-running with the same `since` produces the same outcome. Verified as INV-06 in property-based tests (see `test-strategy.md` §5).
- **Resumable**: each balance reconciliation is transactional, so a process crash mid-run leaves the database consistent. The next scheduled run picks up the remaining pages on its next cycle. (A failed run's `last_completed_at` is not advanced, so the next run repeats the same `since`.)
- **Conservative**: refuses to violate INV-02. A conflict is recorded, not papered over.

---

## 3. Point reconciliation (targeted)

The targeted variant refreshes one `(employee_id, location_id)` from HCM. Triggered by F-05 (HCM rejected with `insufficient_balance` after local validation passed) or by the async post-commit drift signal in TRD §9.2 item 3.

```
function reconcilePoint(employee_id, location_id):
  transaction:
    hcm = HCM.get(employee_id)  # realtime read, scoped to one employee
    local = Balance.find(employee_id, location_id)
    if hcm.total_days == local.total_days: return  # no drift
    reserved = sum(TimeOffRequest.days_requested
                   where matches (employee_id, location_id)
                   and status in (SUBMITTED, APPROVING, CANCELLING))
    if hcm.total_days - reserved >= 0:
      local.total_days = hcm.total_days
      local.version += 1
      local.last_hcm_sync_at = now()
      AuditLog.append("balance.point_reconciled", before, after)
    else:
      AuditLog.append("balance.point_reconciliation.conflict",
                      metadata={hcm_total_days, reserved})
```

Cheap (one HCM realtime read, one local transaction). The affected request can be retried within seconds rather than waiting for the next batch cycle. Same conflict-resolution rules as the batch variant apply.

---

## 4. Expected-total arithmetic check: rationale

The expected-total check (TRD §9.2 item 2) replaced an earlier design that used a synchronous verification GET after every adjust. The replacement matters because of the multi-writer reality (§5 below).

A verification GET after the adjust can't distinguish two cases:

- **Case A.** Our write didn't apply, so HCM still shows `pre_total`.
- **Case B.** Our write applied, AND another writer changed HCM in the same window, so the GET shows neither `pre_total` nor `expected_total`.

Case A is a real failure the service has to catch. Case B is a legitimate concurrent write that the service has no reason to flag. A verification GET treats both identically and surfaces the second as a user-visible failure every time anyone else writes to the same employee in the same window. At even moderate HCM-side write volume, that produces false positives faster than real ones.

The arithmetic check avoids the conflation. If HCM accepts an adjust and replies 2xx with `new_total_days == pre_total + delta` and a non-empty `hcm_correlation_id`, the response is self-consistent: the state HCM applied matches what the service expected. A concurrent writer hitting HCM at the same time produces a different `new_total_days` on **their** adjust response, not on ours.

The asynchronous post-commit drift check (TRD §9.2 item 3) catches the remaining case: HCM responded consistently to our adjust, but external state changed between our adjust and our drift GET. That signal feeds point reconciliation off the hot path. User-facing latency stays bounded; drift detection latency stays low.

---

## 5. Multi-writer acknowledgment

The service is one of several writers to the HCM. HCM-internal processes apply anniversary grants and year-end refresh cycles. HR personnel make manual adjustments through the HCM's own interface. Other consumer applications write through their own integrations.

The HCM doesn't push change notifications. Reconciliation (scheduled batch, on-demand, and the targeted point variant in §3) is the only mechanism through which the service discovers external changes. Two design choices flow from this:

- **The expected-total check is non-negotiable on critical paths.** The local cache can be stale even moments after a recent write because another writer may have changed the value in the same window. Arithmetic comparison against `pre_total + delta` catches the case where HCM's response is inconsistent without flagging legitimate concurrent writers as failures. See §4 for the full rationale.
- **Reconciliation cadence is a tradeoff parameter.** Tighter cadence reduces staleness; looser cadence reduces HCM load. The chosen defaults (15 min in development, 60 min in production) are configurable. The asynchronous post-commit drift check (TRD §9.2 item 3) cuts the detection lag for HCM-side changes that happen during a saga without adding hot-path latency.

---

## 6. Contract soft points

The service treats the HCM contract as soft in three places. Each is defended by an explicit mechanism rather than trusted blindly:

| Soft point | What HCM is documented to do | What the service does instead |
|---|---|---|
| Idempotency guarantee | Returns the original response for a duplicate key | Verifies expected-total on every response; async drift check; audit every call |
| Error fidelity | 4xx on invalid combinations, 409 on insufficient balance | F-05 enumerated as routine; arithmetic check catches the case where HCM says 2xx on what should have been 4xx |
| Response identity on retry | Same response body on duplicate key | Mock supports both strict (same body) and `idempotency-soft` (same outcome, fresh correlation_id) so tests verify the service doesn't depend on response identity |

The mock HCM (`mock-hcm.md`) exposes scenarios that exercise each soft point: `ambiguous-success`, `unverifiable-success`, and `idempotency-soft`.

---

## 7. Cross-references

- Sync model and defensive behaviors at the decision level: TRD §9
- Reservation pattern (two-counter model): ADR-001, TRD §10.1
- Saga shape (compensation, partial-failure recovery): ADR-002, TRD §5
- OCC version-column on Balance: ADR-005, TRD §10.2
- Hybrid realtime + batch sync decision: ADR-006
- Idempotency key construction (`<request_id>:<operation_type>`): ADR-007
- Retry policy and circuit breaker: ADR-008, TRD §11.2 and §11.3
- Failure mode catalog (F-01 through F-08), including F-04 ambiguous and F-05 insufficient_balance: TRD §11.1
- Mock HCM full spec, scenarios, and control plane: `mock-hcm.md`

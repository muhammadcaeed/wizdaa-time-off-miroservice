# ADR-002: Saga over 2PC for HCM coordination

**Status**: Accepted

## Context

Approval and cancellation flows span two systems: the local database (request state, audit, balance) and HCM (authoritative balance). A coordinated state change is required, and partial failures must be observable and recoverable. Three forces:

- HCM is a third-party system; the service cannot enroll it in a distributed transaction protocol like XA / 2PC
- Partial failures (HCM succeeded but local failed, or vice versa) must transition the request to an explicit terminal or retry-able state, not leave it in indeterminate limbo
- Users expect definitive feedback; "indeterminate" is not an acceptable outcome

## Decision

Use a saga pattern. Each cross-system flow is two local transactions bracketing an HCM call.

For approval:
1. Local TX: transition request to APPROVING + audit
2. HCM call: `POST /balances/adjust` (with idempotency key per ADR-007); commit is gated on 2xx with `new_total_days == pre_total + delta` and a non-empty correlation_id
3. Local TX: commit (APPROVED, balance updated) or compensate (APPROVAL_FAILED, reservation released)

The cancellation flow follows the same shape in reverse. Each step is independently retryable. The HCM call is idempotent. Recovery happens through admin retry endpoints that re-enter the saga at the appropriate point.

## Consequences

**Positive:**
- Works without HCM cooperation; no XA support required from a third party
- Each step is testable in isolation; failure paths are explicit (APPROVAL_FAILED, CANCELLATION_FAILED)
- Idempotent retries make recovery deterministic
- The saga shape mirrors the user's mental model: "we tried, here's what happened"

**Negative:**
- Intermediate states (APPROVING, CANCELLING) are visible; the state machine must guard transitions explicitly to prevent concurrent operations from interfering (covered by R-05 in TRD §10.3)
- Compensation logic must be written and tested for every forward operation
- Process crash mid-saga leaves a request in a transient state requiring admin retry; the startup auto-recovery extension in TRD §13.4 closes this gap

## Alternatives Considered

1. **Two-phase commit (XA).** Standard distributed transaction protocol. Rejected: HCM is third-party and doesn't support XA; even if it did, 2PC's blocking failure mode (coordinator crash leaves participants holding locks) is worse than the saga's explicit failure paths.

2. **Optimistic best-effort with manual reconciliation only.** Call HCM, commit locally on success, fail and rely on admin cleanup otherwise. Rejected: no explicit intermediate state means the system can't express "we're trying"; the reservation pattern (ADR-001) needs that state to hold the reservation correctly; failure paths become implicit and hard to test.

3. **Local-first with periodic batch push to HCM.** Treat local as authoritative; sync to HCM in batches. Rejected: reverses the source-of-truth model; HCM is authoritative for employment data by domain contract; would risk silent corruption from concurrent HCM-side writes (anniversary, HR adjustment).

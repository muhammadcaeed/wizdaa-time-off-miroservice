# ADR-012: Cancellation routing — advisory read, authoritative CAS

**Status**: Accepted

## Context

The cancel endpoint (`POST /requests/:id/cancel`, Plan 05) is not a single saga like
approval. It has three behaviors that depend on the request's current state (TRD §5.2):

- `SUBMITTED → CANCELLED` (T-08): release the reservation locally, no HCM call.
- `APPROVAL_FAILED → CANCELLED` (T-06): a *discard* — no HCM call, no balance change
  (the reservation was already released by T-04).
- `APPROVED` with `start_date > today` (T-09): run the reverse saga — an HCM
  increment, mirroring the forward approval saga.

Plus two refusals: `APPROVING`/`CANCELLING` → 409, past-dated `APPROVED` → 409.

Two design questions are not settled by the TRD:

1. **Where does the state-routing dispatch live?** Folding all three paths into one
   `CancellationSagaService.execute()` would make the class a state-machine dispatcher
   with a saga buried inside — the name would lie and SRP would break. Leaking the
   routing into the controller couples the HTTP layer to lifecycle internals.

2. **The route is chosen from a status read, but the transition itself is a
   status-predicate CAS.** Between the read and the CAS a concurrent writer can move
   the request (e.g. a concurrent approve takes `SUBMITTED → APPROVING`). What happens
   when the routed branch's CAS then matches zero rows?

## Decision

**Routing lives in `RequestService.cancel(id, actor)`.** It performs authorization, an
advisory status read, and dispatch:

- The two no-HCM paths (T-08 release, T-06 discard) are small single-transaction
  methods on `RequestService`, structurally identical to the existing `reject` (T-07).
- The APPROVED future-dated path delegates to a new `CancellationSagaService.execute()`,
  the structural twin of `ApprovalSagaService.execute()`. The saga class stays a saga.

**The routing read is advisory; the status-CAS is authoritative.** A stale read can only
mis-route into a branch whose own `casStatus` then matches zero rows; that surfaces as
`409 /errors/invalid-state-transition` (the existing `RequestRepository.casStatus`
contract). We do **not** re-read and re-route on a lost CAS: silently pushing a user who
asked to cancel a `SUBMITTED` request into a reverse HCM saga because a concurrent
approve won would be a surprise, not a correctness improvement. This is the same
advisory-read / authoritative-CAS split the forward saga already relies on.

**T-06 audit signal is `request.discarded`** (not `request.cancelled`). The spec was
internally inconsistent (TRD §5.2 table said `cancelled`, §5.3 note said `discarded`,
Plan 05 omitted it). `request.cancelled` already names two distinct terminals — the T-08
local release and the T-10 saga success — so reusing it for the discard makes "how many
cancellations actually reached HCM?" unanswerable by action name alone. The discard is
operationally distinct (terminal-from-failed, zero balance movement) and gets its own
name.

## Consequences

**Positive:**
- `CancellationSagaService` is a true mirror of `ApprovalSagaService`; reviewers map one
  onto the other. The reverse saga proves ADR-002 composes in both directions.
- The race is handled by the same atomic primitive (status-CAS) the rest of the
  lifecycle uses; no new concurrency mechanism.
- Audit action names stay injective onto transitions, preserving observability.

**Negative:**
- A mis-routed-then-rejected cancel costs one wasted local transaction before the 409.
  Acceptable: the window is tiny and the alternative (re-route) is worse.
- The reverse `fail()` path must **not** release a reservation (CANCELLING holds none) —
  a copy-paste of the forward `fail()` would be a bug. Guarded by a failing test first.

## Alternatives Considered

1. **One `CancellationSagaService.execute()` branching on all three paths.** Rejected:
   SRP violation, the name misleads, and two of three paths never touch HCM.
2. **Route in the controller / `RequestService` returns a discriminated command.**
   Rejected: leaks lifecycle routing into the HTTP layer for no gain.
3. **Re-read and re-route on a lost CAS.** Rejected: turns a concurrency loss into a
   silent change of operation semantics; 409 is the honest answer.

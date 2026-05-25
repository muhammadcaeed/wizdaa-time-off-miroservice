# ADR-010: Foreign-key enforcement strategy

**Status**: Accepted (finalized at cycle 02 start: app-layer integrity, no SQL FK constraints)

## Context

TRD §4.2 lists FK relationships (Employee→Location, Employee→Employee manager self-ref, Balance→Employee/Location, TimeOffRequest→Employee/Location, decided_by→Employee). It does not state whether these are enforced as SQL `FOREIGN KEY` constraints or maintained at the application layer. `AuditLog.entity_id` is explicitly *not* an FK per §4.2.

Two forces are in tension:
- The service is a **defensive mirror**: HCM is the source of truth, and Employee/Location/Balance rows are seeded and reconciled from HCM independently. Enforced FKs can fight out-of-order syncs (e.g., a balance arriving before its employee row).
- Enforced FKs catch referential bugs early and document intent in the schema.

better-sqlite3 also requires `PRAGMA foreign_keys = ON` for declared FKs to be enforced at all.

## Decision

**App-layer integrity, no SQL FK constraints.** Finalized at the start of cycle 02. Referential integrity is enforced in the application layer (services load and validate referenced rows before writing); the schema keeps plain indexed UUID columns. The indexes that back the FK join paths already exist from the cycle-01 migration. `PRAGMA foreign_keys` is left at its default; no FK constraints are declared.

Rationale: the service is a defensive mirror of the HCM. Employee, Location, and Balance rows are seeded and reconciled from the HCM independently and can arrive out of order (a balance before its employee row during a partial sync). Enforced FKs would reject those legitimate intermediate states. The reservation pattern and saga already validate references on the write path where it matters. This keeps the door open to enforced FKs later (a follow-up migration plus `PRAGMA foreign_keys = ON`) if the sync model ever guarantees ordering — see ADR consequences.

## Consequences

**Positive:**
- No friction with the defensive-mirror sync model in cycle 01.
- Migration ships now; the call is made deliberately rather than by accident.

**Negative:**
- No DB-level guarantee against orphaned references until resolved.
- If enforced FKs are later chosen, they arrive via a follow-up migration rather than the initial one.

## Alternatives Considered

1. **Enforce FKs now (TypeORM relations + `foreign_keys` pragma).** Strong integrity, but commits to a model that may fight HCM sync ordering before that path is built. Rejected for cycle 01; left open.
2. **App-layer integrity permanently.** Matches the mirror design, but forgoes a cheap safety net. Not yet decided.

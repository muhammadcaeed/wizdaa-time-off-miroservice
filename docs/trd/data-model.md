# Data Model

Companion to `TRD.md` §4. The TRD carries the ER diagram, the role of each entity, and the key invariants. This file is the implementer's reference: field types, constraints, indexes, and per-entity notes.

The schema targets SQLite for development and CI and PostgreSQL for production. Migrations are committed and explicit. TypeORM's `synchronize: true` is never enabled.

---

## 1. Employee

| Field | Type | Constraints |
|---|---|---|
| id | UUID | PK |
| email | string | UNIQUE, not null |
| first_name, last_name | string | not null |
| location_id | UUID | FK → Location, not null |
| manager_id | UUID | FK → Employee, nullable (self-reference) |
| created_at, updated_at | timestamp | managed |

**Indexes**: `(email)`, `(manager_id)` for direct-report lookups during approval authorization.

Employee data is HCM-sourced. The service treats it as read-mostly reference data; mutations come from reconciliation, not from the API.

---

## 2. Location

| Field | Type | Constraints |
|---|---|---|
| id | UUID | PK |
| name | string | not null |
| country_code | string | ISO 3166-1 alpha-2 |
| created_at | timestamp | managed |

Locations are HCM-sourced reference data, treated like Employee.

---

## 3. Balance

| Field | Type | Constraints |
|---|---|---|
| id | UUID | PK |
| employee_id | UUID | FK → Employee, not null |
| location_id | UUID | FK → Location, not null |
| total_days | integer | not null; sourced from HCM |
| reserved_days | integer | not null, default 0; maintained transactionally |
| version | integer | not null, default 0; incremented on every write |
| last_hcm_sync_at | timestamp | nullable; updated on successful HCM read or reconciliation |
| last_hcm_correlation_id | string | nullable; tracks the most recent HCM operation |
| created_at, updated_at | timestamp | managed |

**Constraints**: UNIQUE on `(employee_id, location_id)`. One balance row per pair. An employee can have multiple balance rows if they hold leave entitlements in more than one location.

**Indexes**: UNIQUE `(employee_id, location_id)`, plus `(employee_id)` for employee-scoped reads.

Every UPDATE to a balance row carries the predicate `WHERE id = :id AND version = :expected_version`. A zero-row update result triggers an OCC retry (TRD §10.2, ADR-005).

---

## 4. TimeOffRequest

| Field | Type | Constraints |
|---|---|---|
| id | UUID | PK |
| employee_id | UUID | FK → Employee, not null |
| location_id | UUID | FK → Location, not null |
| start_date | date | not null |
| end_date | date | not null; `>= start_date` |
| days_requested | integer | not null; `> 0` |
| status | string | not null; SUBMITTED, APPROVING, APPROVED, APPROVAL_FAILED, REJECTED, CANCELLING, CANCELLATION_FAILED, CANCELLED |
| submitted_at | timestamp | not null |
| decided_at | timestamp | nullable; set on APPROVED, REJECTED, APPROVAL_FAILED |
| decided_by | UUID | FK → Employee, nullable; the manager who acted |
| hcm_correlation_id | string | nullable; set during APPROVING, persists through APPROVED / APPROVAL_FAILED |
| failure_reason | string | nullable; populated on APPROVAL_FAILED or CANCELLATION_FAILED |
| reason | string | nullable; employee-provided context |
| created_at, updated_at | timestamp | managed |

**Indexes**: `(employee_id, status)`, `(status)` for reconciliation scans, `(start_date)` for date-range queries.

Status transitions are enumerated in TRD §5.2. All status updates use a status-predicate CAS (`WHERE id = :id AND status = :expected_status`); zero-row results map to `/errors/invalid-state-transition` (409) without retry.

---

## 5. AuditLog

Append-only. Every state change and every HCM interaction produces a row.

| Field | Type | Constraints |
|---|---|---|
| id | UUID | PK |
| timestamp | timestamp | not null, indexed |
| actor_id | UUID | nullable; null for SYSTEM actions |
| actor_type | string | EMPLOYEE, MANAGER, ADMIN, SYSTEM |
| entity_type | string | REQUEST, BALANCE, HCM_CALL |
| entity_id | string | not null; reference to the entity (not enforced as FK) |
| action | string | dotted notation, e.g. `request.approved`, `balance.reconciled`, `hcm.decrement.ambiguous` |
| before_state | JSON | nullable; serialized entity snapshot before the change |
| after_state | JSON | nullable; serialized entity snapshot after the change |
| correlation_id | string | nullable; ties together saga events (a full approval saga shares one) |
| metadata | JSON | nullable; HCM response details, error codes, retry counts |

**Indexes**: `(entity_type, entity_id)`, `(correlation_id)`, `(timestamp)`.

Append-only is enforced at the application layer (the audit repository exposes only `insert`) and verified by INV-05 (TRD §4.2). A database-level enforcement option (role permissions, or a trigger that raises on UPDATE/DELETE) is listed as a designed-for extension in TRD §13.4.

The audit row is always written in the same transaction as the state change it describes. A state change without an audit row is impossible because they share the commit boundary.

---

## 6. IdempotencyRecord

Persistent storage for client-facing idempotency (`Idempotency-Key` header on writes). Lives in the same SQLite database. A periodic cleanup job removes rows past their `expires_at`.

| Field | Type | Constraints |
|---|---|---|
| key | string | PK; the client-supplied `Idempotency-Key` |
| request_hash | string | SHA-256 of the canonicalized request body |
| response_body | JSON | serialized response payload |
| response_status | integer | HTTP status of the original response |
| created_at | timestamp | not null |
| expires_at | timestamp | not null; `created_at + 24h` by default |

**Indexes**: PK on `key`, plus `(expires_at)` for the cleanup job.

Semantics (same key + same body replays original response; same key + different body returns 422; missing key on writes returns 400) are detailed in `api-contract.md` §6. This entity stores the **client-facing** idempotency state. The HCM-side idempotency key (`<request_id>:<operation_type>`) is computed deterministically and isn't persisted (ADR-007).

---

## 7. Reconciliation

A tracked resource per reconciliation run (scheduled, on-demand, or point).

| Field | Type | Constraints |
|---|---|---|
| id | UUID | PK |
| status | string | RUNNING, COMPLETED, COMPLETED_WITH_CONFLICTS, FAILED |
| since | timestamp | inclusive lower bound used for the HCM batch query |
| started_at | timestamp | not null |
| completed_at | timestamp | nullable until run finishes |
| balances_examined | integer | not null, default 0 |
| conflicts | integer | not null, default 0 |
| trigger_type | string | SCHEDULED, ON_DEMAND, POINT |

A `UNIQUE` partial index on `(status)` where `status = 'RUNNING'` enforces "only one RUNNING run at a time" (covers REQ-REC-06). The partial-index syntax differs between SQLite and Postgres, but both support it.

The full reconciliation algorithm pseudocode is in `hcm-integration.md` §2; the point-reconciliation variant is in §3 of the same file.

---

## 8. Cross-references

- ER diagram and entity roles: TRD §4.1
- Key invariants (INV-01 through INV-05): TRD §4.2
- Reservation pattern (the two-counter model on Balance): TRD §10.1, ADR-001
- OCC version column on Balance: TRD §10.2, ADR-005
- TimeOffRequest state machine: TRD §5.2
- HCM correlation id semantics: TRD §9.2 item 4, ADR-007
- Idempotency semantics for the `Idempotency-Key` header: `api-contract.md` §6
- Reconciliation as a tracked resource: TRD §9.2
- Postgres migration notes: TRD §15, `concurrency.md` §3

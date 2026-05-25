# Mock HCM Specification

Companion to `TRD.md` and `test-strategy.md`. The TRD describes the assumed HCM contract (§9.1); this file specifies the mock implementation: surfaces, control plane, supported scenarios, storage, idempotency tracking, and the lifecycle in dev and test environments.

The mock exists in two modes (in-process module and out-of-process child process). Both use the same code; the difference is harness wiring. See `test-strategy.md` §2 for which test layer uses which mode.

---

## 1. Goals

The mock HCM has to:

- Faithfully implement the contract in TRD §9.1 (`GET /hcm/balances/:employee_id`, `POST /hcm/balances/adjust`, `GET /hcm/balances/batch`) so the service's HCM client never observes "this works against the mock but not the real one"
- Support deterministic test scenarios that the service can't reliably exercise against an actual HCM (timeouts, 5xx storms, ambiguous responses, drift injection)
- Track idempotency keys the way the assumed HCM contract specifies, so retry behavior is testable
- Reset cleanly between tests with no shared state

## 2. Public surface (mirrors TRD §9.1)

### 2.1 `GET /hcm/balances/:employee_id`

Returns all balances for the employee, one row per location.

Response:

```json
{
  "employee_id": "emp_abc",
  "balances": [
    { "location_id": "loc_xyz", "total_days": 18, "last_modified_at": "2026-05-22T09:14:00Z" }
  ]
}
```

Status: 200 success, 404 employee unknown, 5xx server error (scenario-driven).

### 2.2 `POST /hcm/balances/adjust`

Idempotent under `Idempotency-Key`. Request:

```json
{
  "employee_id": "emp_abc",
  "location_id": "loc_xyz",
  "delta": -5,
  "operation_type": "DECREMENT",
  "source_reference": "request:req_123"
}
```

Header: `Idempotency-Key: req_123:decrement`.

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

Status: 200 success, 409 insufficient balance, 422 invalid combination, 5xx server error.

### 2.3 `GET /hcm/balances/batch?since=<iso8601>&cursor=<opaque>`

Paginated batch corpus. Returns balances modified at or after the `since` timestamp. Same row shape as 2.1, paginated with cursor convention from `api-contract.md` §5.

---

## 3. Control plane (test-only)

Mounted under `/mock/control` in test/development builds only; absent in any build that could ship to a non-test environment. Authentication is intentionally absent because the control plane is reachable only from the test harness.

### 3.1 `POST /mock/control/scenarios`

Set the current behavior scenario per endpoint. Body:

```json
{
  "endpoints": {
    "adjust": "ambiguous-success",
    "get_balance": "normal",
    "batch": "normal"
  },
  "scope": { "employee_id": "emp_abc" }
}
```

`scope` is optional. When omitted, the scenario applies globally. When present, it applies only to operations matching the scope filter. Scopes can include `employee_id`, `location_id`, or both.

### 3.2 `POST /mock/control/balances`

Inject a balance value directly into mock storage. Simulates anniversary grants, manual HR edits, or any HCM-side change the service didn't initiate.

```json
{
  "employee_id": "emp_abc",
  "location_id": "loc_xyz",
  "total_days": 25,
  "last_modified_at": "2026-05-24T15:30:00Z"
}
```

Triggers no notification to the service. The service discovers the change only via reconciliation or the post-commit drift check.

### 3.3 `POST /mock/control/drift`

Silently changes a balance without updating `last_modified_at`. Tests the case where the batch endpoint's `since` filter wouldn't surface the change. Used to verify that the post-commit drift check (REQ-SYNC-04a) catches what reconciliation might miss.

```json
{
  "employee_id": "emp_abc",
  "location_id": "loc_xyz",
  "total_days": 12
}
```

### 3.4 `POST /mock/control/reset`

Restores the mock to its default state: scenarios cleared to `normal`, storage seeded from the fixture, idempotency cache emptied. Called in `beforeEach` of every test.

### 3.5 `GET /mock/control/state`

Returns the current mock state for assertions: scenario map, full storage contents, idempotency cache contents (keys only, not bodies). Used by tests that assert against mock-side observable state.

### 3.6 `GET /mock/control/calls`

Returns a structured log of recent calls (default last 100): method, path, body, headers, response status, timestamp. Used by contract and chaos tests to assert that the HCM client sent what was expected.

---

## 4. Supported scenarios

| Scenario | Behavior | Tests it enables |
|---|---|---|
| `normal` | Behaves per the contract | Happy paths |
| `slow` | Adds configurable latency (`?latency_ms=` query parameter or per-scenario default of 2000ms) | Timeout handling, p95 latency assertions |
| `flaky` | Returns 5xx on a configurable percentage of calls (`?fail_rate=0.3`) | Retry behavior, circuit breaker accounting |
| `ambiguous-success` | Returns 200 but the underlying balance doesn't change | Defensive behavior: arithmetic check catches the mismatch |
| `down` | Returns 503 on all calls | Circuit breaker open path |
| `unverifiable-success` | Returns 200 with `new_total_days` that disagrees with `pre_total + delta`, and a subsequent GET also disagrees | F-04 (ambiguous response); async drift detection |
| `network-failure` | Closes the connection mid-response or refuses the connection entirely (mode configurable) | F-01 (network errors), client error handling |
| `idempotency-replay` | Returns the original response for any duplicate key, regardless of body | Verifies idempotency on retries works against a strict-matching HCM |
| `idempotency-soft` | Returns 200 for duplicate key but with a fresh `hcm_correlation_id` (simulates an HCM that's idempotent only in result, not in response identity) | Tests that the service doesn't depend on response-identity for idempotency |

Scenarios compose where reasonable: `slow` + `flaky` together produces slow responses that sometimes fail. Composition is per-endpoint, set via the scope on `POST /mock/control/scenarios`.

---

## 5. Storage model

In-memory `Map<string, BalanceRow>` keyed by `${employee_id}:${location_id}`. Seeded at startup from a JSON fixture:

```json
[
  {
    "employee_id": "emp_001",
    "location_id": "loc_001",
    "total_days": 20,
    "last_modified_at": "2026-01-01T00:00:00Z"
  }
]
```

The fixture file is `apps/mock-hcm/fixtures/balances.json` and lives next to the mock source. Tests can override the fixture path via the `MOCK_HCM_FIXTURE_PATH` environment variable.

The storage is process-local. In out-of-process mode, each spawned mock process has its own storage. Tests that span multiple processes coordinate via the control plane, not via shared storage.

---

## 6. Idempotency tracking

The mock stores idempotency keys for the lifetime of the process (or until `reset`). Behavior:

- Same key + same request body → returns the original response verbatim
- Same key + different request body → returns 409 (mirrors strict-mode behavior from a real HCM that fingerprints the body)
- New key → executes the operation and stores the response

The `Idempotency-Key` cache is observable via `GET /mock/control/state` for assertions.

The `idempotency-soft` scenario relaxes this: same key still returns 200 but with a fresh correlation_id, simulating HCMs where idempotency is "we won't double-apply" but "you might get different metadata."

---

## 7. Implementation

Standalone NestJS application in `apps/mock-hcm/`:

```
apps/mock-hcm/
├── src/
│   ├── main.ts              # Bootstrap (out-of-process mode)
│   ├── mock-hcm.module.ts   # Module export for in-process mode
│   ├── controllers/
│   │   ├── balances.controller.ts
│   │   └── control.controller.ts
│   ├── services/
│   │   ├── storage.service.ts
│   │   ├── scenario.service.ts
│   │   └── idempotency.service.ts
│   └── dto/                 # Independent from the main service's DTOs
├── fixtures/
│   └── balances.json
└── package.json
```

The mock uses an independent set of DTOs from the main service. Sharing validation logic would mask serialization mismatches that real HCM clients would surface. The mock's DTOs are a copy of the assumed contract; if the service's request shape drifts, the mock rejects it (404 or 422), which is what production would do.

## 8. Lifecycle

### 8.1 Local development

`npm run mock-hcm` starts the mock on `MOCK_HCM_PORT` (default 4001). The main service's `HCM_BASE_URL` env var points to it. Hot reload via `ts-node-dev`.

### 8.2 CI / test runs

- **In-process mode**: imported as a NestJS module in the test harness. No port allocation.
- **Out-of-process mode**: each test suite spawns a fresh process on a port from a CI-allocated range (e.g., 4100-4199), recorded in a port file. The harness reads the port file and configures the service's HCM client accordingly. Process cleanup is handled by `afterAll`.

### 8.3 Never in production

The mock binary is excluded from production builds via `NODE_ENV !== 'production'` checks at startup and via the build pipeline excluding the `apps/mock-hcm/` directory from production artifacts.

---

## 9. Cross-references

- Contract assumed by the main service: TRD §9.1
- Defensive behaviors the mock helps exercise: TRD §9.2, §11
- Failure modes the mock simulates: TRD §11.1 (F-01 through F-08)
- Test layers using the mock: `test-strategy.md` §1, §2

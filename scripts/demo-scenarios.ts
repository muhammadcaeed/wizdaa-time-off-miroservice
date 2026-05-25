import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DemoHarness, IDS } from './demo/harness';
import { type BalanceSnapshot, type ScenarioRecord, renderShowcase } from './demo/render';

const SHOWCASE_PATH = join(__dirname, '..', 'docs', 'demo', 'SHOWCASE.md');

class AssertionError extends Error {}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new AssertionError(msg);
}

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

interface ReqResp {
  id: string;
  status: string;
}
interface BalResp {
  balances: { total_days: number; reserved_days: number; available_days: number }[];
}
interface ReconResp {
  id: string;
  status: string;
  conflicts: number;
  balances_examined: number;
}
const asReq = (r: { body: unknown }): ReqResp => r.body as ReqResp;
const asRecon = (r: { body: unknown }): ReconResp => r.body as ReconResp;

async function balanceOf(h: DemoHarness, sub: string, token: string): Promise<BalanceSnapshot> {
  const res = await h.svc('GET', `/balances/employees/${sub}`, { token });
  const b = (res.body as BalResp).balances[0];
  return { total: b.total_days, reserved: b.reserved_days, available: b.available_days };
}

async function pollStatus(
  h: DemoHarness,
  sub: string,
  token: string,
  reqId: string,
  terminal: string[],
  maxMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const res = await h.svc('GET', `/requests/${reqId}`, { token });
    const status = asReq(res).status;
    if (terminal.includes(status)) return status;
    if (Date.now() > deadline) throw new AssertionError(`request ${reqId} stuck at ${status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function pollRecon(h: DemoHarness, runId: string, maxMs = 10_000): Promise<ReconResp> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const res = await h.svc('GET', `/reconciliations/${runId}`, { token: h.actors.admin.token });
    const recon = asRecon(res);
    if (recon.status === 'COMPLETED' || recon.status === 'COMPLETED_WITH_CONFLICTS') return recon;
    if (Date.now() > deadline)
      throw new AssertionError(`reconciliation ${runId} stuck at ${recon.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const submitBody = (days: number) => ({
  location_id: IDS.location,
  start_date: '2026-07-01',
  end_date: '2026-07-05',
  days_requested: days,
});

// --- Scenarios -------------------------------------------------------------

async function reservation(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_reserve', 10);
  const before = await balanceOf(h, a.sub, a.token);
  const callsBefore = (await h.hcmCalls()).length;
  const res = await h.svc('POST', '/requests', {
    token: a.token,
    idempotencyKey: randomUUID(),
    body: submitBody(2),
  });
  assert(res.status === 201, `submit expected 201, got ${res.status}`);
  assert(asReq(res).status === 'SUBMITTED', `expected SUBMITTED, got ${asReq(res).status}`);
  const after = await balanceOf(h, a.sub, a.token);
  const callsAfter = (await h.hcmCalls()).length;
  assert(after.reserved === before.reserved + 2, 'reservation did not increment reserved_days');
  assert(callsAfter === callsBefore, 'submit must not call HCM');
  return {
    id: 'reservation',
    title: 'Instant reservation, no HCM round-trip',
    theme: 'Lifecycle',
    challenges: [],
    intro:
      'An employee submits a request. The service reserves the days locally and returns immediately — the employee gets instant feedback and the HCM is never touched on the submit path.',
    events: [
      { from: 'Employee', to: 'Service', label: 'POST /requests (2 days)' },
      { from: 'Service', to: 'DB', label: 'reserve 2 days (one tx)' },
      { from: 'Service', to: 'Employee', label: '201 SUBMITTED', reply: true },
      { from: 'Service', to: 'HCM', label: 'no call on submit', note: true },
    ],
    before,
    after,
    takeaways: [
      'Reads and submissions stay local — availability does not depend on the HCM.',
      'The reservation makes the balance instantly reflect in-flight requests.',
    ],
  };
}

async function forwardSaga(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_approve', 10);
  const before = await balanceOf(h, a.sub, a.token);
  const submit = await h.svc('POST', '/requests', {
    token: a.token,
    idempotencyKey: randomUUID(),
    body: submitBody(3),
  });
  assert(submit.status === 201, `submit expected 201, got ${submit.status}`);
  const reqId = asReq(submit).id;
  const callsBefore = (await h.hcmCalls()).length;
  const approve = await h.svc('POST', `/requests/${reqId}/approve`, {
    token: h.actors.manager.token,
    idempotencyKey: randomUUID(),
  });
  assert(approve.status === 202, `approve expected 202, got ${approve.status}`);
  const final = await pollStatus(h, a.sub, a.token, reqId, ['APPROVED', 'APPROVAL_FAILED']);
  assert(final === 'APPROVED', `expected APPROVED, got ${final}`);
  const callsAfter = (await h.hcmCalls()).length;
  assert(callsAfter > callsBefore, 'approval must call the HCM adjust endpoint');
  const after = await balanceOf(h, a.sub, a.token);
  assert(after.total === before.total - 3 && after.reserved === 0, 'commit math wrong');
  return {
    id: 'forward-saga',
    title: 'Approval saga with arithmetic-verified HCM commit',
    theme: 'Lifecycle',
    challenges: ['Challenge 2', 'Challenge 4'],
    intro:
      'A manager approves. The saga calls the realtime HCM adjust, then verifies the response arithmetically (new_total == pre_total − days) and that a correlation id is present before committing locally.',
    events: [
      { from: 'Manager', to: 'Service', label: 'POST /requests/:id/approve' },
      { from: 'Service', to: 'HCM', label: 'POST /balances/adjust (delta −3)' },
      { from: 'HCM', to: 'Service', label: '200 new_total=7, correlation_id', reply: true },
      { from: 'Service', to: 'Service', label: 'arithmetic check: 10 − 3 == 7 ✓', note: true },
      { from: 'Service', to: 'DB', label: 'commit: total 7, reserved 0 (one tx)' },
    ],
    before,
    after,
    takeaways: [
      'Realtime HCM API (Challenge 2): the saga writes the single balance value.',
      'Defensive (Challenge 4): a 2xx is not trusted until the math and correlation id check out.',
    ],
  };
}

async function reverseSaga(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_cancel', 10);
  const before = await balanceOf(h, a.sub, a.token);
  const submit = await h.svc('POST', '/requests', {
    token: a.token,
    idempotencyKey: randomUUID(),
    body: submitBody(2),
  });
  const reqId = asReq(submit).id;
  await h.svc('POST', `/requests/${reqId}/approve`, {
    token: h.actors.manager.token,
    idempotencyKey: randomUUID(),
  });
  await pollStatus(h, a.sub, a.token, reqId, ['APPROVED']);
  const cancel = await h.svc('POST', `/requests/${reqId}/cancel`, {
    token: a.token,
    idempotencyKey: randomUUID(),
  });
  assert(cancel.status === 202, `future-dated cancel expected 202, got ${cancel.status}`);
  const final = await pollStatus(h, a.sub, a.token, reqId, ['CANCELLED', 'CANCELLATION_FAILED']);
  assert(final === 'CANCELLED', `expected CANCELLED, got ${final}`);
  const after = await balanceOf(h, a.sub, a.token);
  assert(after.total === before.total && after.reserved === 0, 'balance not restored after cancel');
  return {
    id: 'reverse-saga',
    title: 'Cancellation reverse saga (symmetry)',
    theme: 'Lifecycle',
    challenges: [],
    intro:
      'Cancelling a future-dated APPROVED request runs the reverse saga: an HCM increment restores the days, verified the same way as the forward saga. Total dips to 8 on approval, then returns to 10.',
    events: [
      { from: 'Employee', to: 'Service', label: 'POST /requests/:id/cancel' },
      { from: 'Service', to: 'HCM', label: 'POST /balances/adjust (delta +2)' },
      { from: 'HCM', to: 'Service', label: '200 new_total=10, correlation_id', reply: true },
      { from: 'Service', to: 'DB', label: 'commit: total 10 (one tx)' },
    ],
    before,
    after,
    takeaways: [
      'The reverse saga mirrors the forward one — same arithmetic guarantee, opposite delta.',
      'Net effect over approve+cancel is balance-preserving.',
    ],
  };
}

async function anniversaryDrift(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_anniv', 10);
  // Reserve 4 days so the unsafe case has something to conflict with.
  const submit = await h.svc('POST', '/requests', {
    token: a.token,
    idempotencyKey: randomUUID(),
    body: submitBody(4),
  });
  assert(submit.status === 201, 'setup submit failed');
  const before = await balanceOf(h, a.sub, a.token);

  // Safe drift: an anniversary grant raises the HCM total out-of-band.
  await h.control('balances', { employee_id: a.sub, location_id: IDS.location, total_days: 15 });
  const run1 = await h.svc('POST', '/reconciliations', {
    token: h.actors.admin.token,
    idempotencyKey: randomUUID(),
  });
  await pollRecon(h, asReq(run1).id);
  const afterSafe = await balanceOf(h, a.sub, a.token);
  assert(afterSafe.total === 15, `safe drift not absorbed: total ${afterSafe.total}`);

  // Unsafe drift: HCM total below what is already reserved → refused as conflict.
  await h.control('balances', { employee_id: a.sub, location_id: IDS.location, total_days: 2 });
  const run2 = await h.svc('POST', '/reconciliations', {
    token: h.actors.admin.token,
    idempotencyKey: randomUUID(),
  });
  const run2res = await pollRecon(h, asReq(run2).id);
  const afterUnsafe = await balanceOf(h, a.sub, a.token);
  assert(afterUnsafe.total === 15, 'unsafe drift must NOT be applied');
  assert(run2res.conflicts >= 1, 'unsafe drift must raise a conflict');
  return {
    id: 'anniversary-drift',
    title: 'External writer (anniversary grant) reconciled — safe vs unsafe',
    theme: 'Consistency',
    challenges: ['Challenge 1'],
    intro:
      'The HCM total changes out-of-band (an anniversary grant). Reconciliation absorbs the safe increase (10→15). A later drift that would drop the total below the 4 reserved days is refused and counted as a conflict, protecting in-flight requests.',
    events: [
      { from: 'HCM', to: 'HCM', label: 'anniversary grant: total 10 → 15', note: true },
      { from: 'Admin', to: 'Service', label: 'POST /reconciliations' },
      { from: 'Service', to: 'HCM', label: 'GET /balances/batch?since=' },
      { from: 'HCM', to: 'Service', label: 'corpus incl. total=15', reply: true },
      { from: 'Service', to: 'DB', label: 'safe: update local total → 15' },
      { from: 'HCM', to: 'HCM', label: 'later drift: total → 2 (< 4 reserved)', note: true },
      { from: 'Service', to: 'DB', label: 'unsafe: refuse, count conflict' },
    ],
    before,
    after: afterUnsafe,
    takeaways: [
      'Challenge 1: changes from other HCM writers are discovered by reconciliation, not webhooks.',
      'A reconciliation never corrupts a balance: if HCM < reserved, it conflicts instead of applying.',
    ],
  };
}

async function batchCorpus(h: DemoHarness): Promise<ScenarioRecord> {
  const e1 = await h.seedEmployee('emp_batch1', 10);
  const e2 = await h.seedEmployee('emp_batch2', 10);
  // Drift both HCM balances out-of-band.
  await h.control('balances', { employee_id: e1.sub, location_id: IDS.location, total_days: 12 });
  await h.control('balances', { employee_id: e2.sub, location_id: IDS.location, total_days: 8 });
  const run = await h.svc('POST', '/reconciliations', {
    token: h.actors.admin.token,
    idempotencyKey: randomUUID(),
  });
  const res = await pollRecon(h, asReq(run).id);
  assert(res.balances_examined >= 2, 'batch run should examine the corpus');
  const b1 = await balanceOf(h, e1.sub, e1.token);
  const b2 = await balanceOf(h, e2.sub, e2.token);
  assert(b1.total === 12 && b2.total === 8, 'batch reconciliation did not apply corpus drift');
  return {
    id: 'batch-corpus',
    title: 'Batch corpus reconciliation',
    theme: 'Consistency',
    challenges: ['Challenge 3'],
    intro:
      'A single reconciliation run pulls the whole HCM corpus with a `since=` cursor and reconciles every balance, reporting how many it examined and how many conflicted.',
    events: [
      { from: 'HCM', to: 'HCM', label: 'two balances drift out-of-band', note: true },
      { from: 'Admin', to: 'Service', label: 'POST /reconciliations' },
      { from: 'Service', to: 'HCM', label: 'GET /balances/batch?since= (paginated)' },
      { from: 'HCM', to: 'Service', label: 'corpus page(s)', reply: true },
      {
        from: 'Service',
        to: 'DB',
        label: `examined ${res.balances_examined}, conflicts ${res.conflicts}`,
      },
    ],
    takeaways: [
      'Challenge 3: the batch endpoint catches up on everything that changed since the last run.',
      'Each balance is reconciled under optimistic concurrency, safe against concurrent sagas.',
    ],
  };
}

async function ambiguousHcm(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_ambig', 10);
  const before = await balanceOf(h, a.sub, a.token);
  // Scope an ambiguous-success adjust to this employee only.
  await h.control('scenarios', {
    endpoints: { adjust: 'ambiguous-success' },
    scope: { employee_id: a.sub },
  });
  const submit = await h.svc('POST', '/requests', {
    token: a.token,
    idempotencyKey: randomUUID(),
    body: submitBody(3),
  });
  const reqId = asReq(submit).id;
  const approve = await h.svc('POST', `/requests/${reqId}/approve`, {
    token: h.actors.manager.token,
    idempotencyKey: randomUUID(),
  });
  assert(approve.status === 202, `approve expected 202, got ${approve.status}`);
  const final = await pollStatus(h, a.sub, a.token, reqId, ['APPROVED', 'APPROVAL_FAILED']);
  assert(final === 'APPROVAL_FAILED', `ambiguous HCM must fail the saga, got ${final}`);
  const after = await balanceOf(h, a.sub, a.token);
  assert(
    after.reserved === 0 && after.total === before.total,
    'reservation must be released on failure',
  );
  // Restore normal behavior for this employee.
  await h.control('scenarios', { endpoints: { adjust: 'normal' }, scope: { employee_id: a.sub } });
  return {
    id: 'ambiguous-hcm',
    title: 'Ambiguous HCM success is treated as failure',
    theme: 'Resilience',
    challenges: ['Challenge 4'],
    intro:
      'The HCM returns 200 but the new total does not match pre_total − days (an "it worked… or did it?" response). The arithmetic check catches it: the saga moves to APPROVAL_FAILED, releases the reservation, and enqueues a point reconciliation rather than trusting the 2xx.',
    events: [
      { from: 'Manager', to: 'Service', label: 'POST /requests/:id/approve' },
      { from: 'Service', to: 'HCM', label: 'POST /balances/adjust (delta −3)' },
      { from: 'HCM', to: 'Service', label: '200 but new_total inconsistent', reply: true },
      { from: 'Service', to: 'Service', label: 'arithmetic check fails → ambiguous', note: true },
      {
        from: 'Service',
        to: 'DB',
        label: 'APPROVAL_FAILED, release reservation, enqueue point recon',
      },
    ],
    before,
    after,
    takeaways: [
      'Challenge 4: a 2xx is never trusted blindly — the math must agree.',
      'Failure is safe: the reservation is released and the balance is left intact.',
    ],
  };
}

async function concurrencyRace(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_race', 3);
  const before = await balanceOf(h, a.sub, a.token);
  const [r1, r2] = await Promise.all([
    h.svc('POST', '/requests', {
      token: a.token,
      idempotencyKey: randomUUID(),
      body: submitBody(2),
    }),
    h.svc('POST', '/requests', {
      token: a.token,
      idempotencyKey: randomUUID(),
      body: submitBody(2),
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert(
    statuses[0] === 201 && statuses[1] === 409,
    `expected one 201 + one 409, got ${statuses.join(',')}`,
  );
  const after = await balanceOf(h, a.sub, a.token);
  assert(after.reserved === 2, `exactly one reservation should hold; reserved=${after.reserved}`);
  return {
    id: 'concurrency-race',
    title: 'Concurrent submissions cannot oversell a balance',
    theme: 'Consistency',
    challenges: [],
    intro:
      'Two requests for 2 days race against a 3-day balance. Optimistic concurrency lets exactly one win; the other gets 409. The invariant available_days ≥ 0 holds — no overselling.',
    events: [
      { from: 'Employee', to: 'Service', label: 'POST /requests (2d)  ×2 concurrently' },
      { from: 'Service', to: 'DB', label: 'version-checked reserve (CAS)' },
      { from: 'Service', to: 'Employee', label: 'one 201, one 409 insufficient', reply: true },
    ],
    before,
    after,
    takeaways: [
      'Optimistic concurrency serializes contending writers per (employee, location).',
      'INV: total − reserved never goes negative, even under a race.',
    ],
  };
}

async function idempotencyReplay(h: DemoHarness): Promise<ScenarioRecord> {
  const a = await h.seedEmployee('emp_idem', 10);
  const before = await balanceOf(h, a.sub, a.token);
  const key = randomUUID();
  const body = submitBody(2);
  const first = await h.svc('POST', '/requests', { token: a.token, idempotencyKey: key, body });
  const second = await h.svc('POST', '/requests', { token: a.token, idempotencyKey: key, body });
  assert(first.status === 201, `first submit expected 201, got ${first.status}`);
  assert(
    second.status === 201 && asReq(second).id === asReq(first).id,
    'replay must return the original response',
  );
  const after = await balanceOf(h, a.sub, a.token);
  assert(after.reserved === 2, `replay must not double-reserve; reserved=${after.reserved}`);
  return {
    id: 'idempotency-replay',
    title: 'Idempotent retry returns the original, reserves once',
    theme: 'Consistency',
    challenges: [],
    intro:
      'A client retries the same POST with the same Idempotency-Key (e.g. after a flaky network). The server replays the stored response without re-executing — the days are reserved exactly once.',
    events: [
      { from: 'Employee', to: 'Service', label: 'POST /requests (Idempotency-Key K)' },
      { from: 'Service', to: 'DB', label: 'reserve + store (key, response) in one tx' },
      { from: 'Employee', to: 'Service', label: 'POST /requests (same key K) — retry' },
      { from: 'Service', to: 'Employee', label: 'replay stored 201, no re-execute', reply: true },
    ],
    before,
    after,
    takeaways: [
      'Client idempotency protects against double-submission on retries.',
      'The record shares the operation transaction, so replay can never diverge from the original.',
    ],
  };
}

const SCENARIOS = [
  reservation,
  forwardSaga,
  reverseSaga,
  ambiguousHcm,
  anniversaryDrift,
  batchCorpus,
  concurrencyRace,
  idempotencyReplay,
];

async function main(): Promise<void> {
  const build = !process.argv.includes('--no-build');
  const outPath = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : SHOWCASE_PATH;
  log('Booting time-off-service + mock HCM…');
  const h = await DemoHarness.start({ initialBalanceDays: 10, build });
  const records: ScenarioRecord[] = [];
  try {
    for (const scenario of SCENARIOS) {
      const rec = await scenario(h);
      records.push(rec);
      log(`  ✓ ${rec.title}`);
    }
    mkdirSync(join(outPath, '..'), { recursive: true });
    writeFileSync(outPath, renderShowcase(records));
    log('');
    log(`DEMO PASSED — ${records.length} scenarios. Showcase written to ${outPath}`);
  } catch (err) {
    log('');
    log(`DEMO FAILED: ${err instanceof Error ? err.message : String(err)}`);
    h.stop();
    process.exit(1);
  } finally {
    h.stop();
  }
}

void main();

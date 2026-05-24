import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AuditService } from '../../common/audit/audit.service';
import { Balance, Employee, Location, TimeOffRequest } from '../../database/entities';
import { BalanceRepository } from '../balances/balance.repository';
import { CircuitBreaker } from '../hcm-sync/circuit-breaker';
import type { HcmBalanceRow, HcmBatchPage, HcmReader } from '../hcm-sync/hcm-reader';
import { RequestRepository } from '../time-off/request.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import { ReconciliationService } from './reconciliation.service';

const NUM_RUNS = process.env.CI ? 200 : 50;
const LOC = 'loc_0';

/** A breaker held CLOSED; reconciliation property tests never exercise HCM failure. */
const closedBreaker = (): CircuitBreaker =>
  new CircuitBreaker(
    { failureThreshold: 5, failureRate: 0.5, cooldownMs: 30_000, probeDeadlineMs: 10_000 },
    Date.now,
    { info: () => undefined } as unknown as PinoLogger,
  );

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

/**
 * In-memory {@link HcmReader} fake: the source-of-truth HCM totals keyed by
 * employee. `getBatch` returns the whole corpus on a single page (the `since`
 * filter is irrelevant for the idempotence corpus, which is static).
 */
class FakeHcmReader implements HcmReader {
  constructor(private readonly totals: Map<string, number>) {}

  getBalances(employeeId: string): Promise<HcmBalanceRow[]> {
    const total = this.totals.get(employeeId);
    if (total === undefined) return Promise.resolve([]);
    return Promise.resolve([
      { employeeId, locationId: LOC, totalDays: total, lastModifiedAt: new Date().toISOString() },
    ]);
  }

  getBatch(): Promise<HcmBatchPage> {
    const rows: HcmBalanceRow[] = [...this.totals.entries()].map(([employeeId, totalDays]) => ({
      employeeId,
      locationId: LOC,
      totalDays,
      lastModifiedAt: new Date().toISOString(),
    }));
    return Promise.resolve({ rows, nextCursor: null, hasMore: false });
  }
}

interface Harness {
  dataSource: DataSource;
  service: ReconciliationService;
  balanceRepo: BalanceRepository;
}

/** Seeds N employees with the given local totals/reserved and wires a reconciler over `hcmTotals`. */
async function makeHarness(
  locals: { total: number; reserved: number }[],
  hcmTotals: Map<string, number>,
): Promise<Harness> {
  const dataSource = await createTestDataSource();
  await dataSource.getRepository(Location).insert({ id: LOC, name: 'HQ', countryCode: 'US' });
  for (let i = 0; i < locals.length; i++) {
    await dataSource.getRepository(Employee).insert({
      id: `emp_${i}`,
      email: `e${i}@x.io`,
      firstName: 'E',
      lastName: `${i}`,
      locationId: LOC,
      managerId: null,
    });
    await dataSource.getRepository(Balance).insert({
      id: `bal_${i}`,
      employeeId: `emp_${i}`,
      locationId: LOC,
      totalDays: locals[i].total,
      reservedDays: locals[i].reserved,
      version: 0,
    });
    if (locals[i].reserved > 0) {
      // A SUBMITTED request backs the reservation so sumReservedDays (INV-03) matches.
      await dataSource.getRepository(TimeOffRequest).insert({
        id: `req_${i}`,
        employeeId: `emp_${i}`,
        locationId: LOC,
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: locals[i].reserved,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      });
    }
  }

  const balanceRepo = new BalanceRepository(dataSource);
  const requestRepo = new RequestRepository(dataSource);
  const audit = new AuditService(new AuditRepository());
  const reconRepo = new ReconciliationRepository(dataSource);
  const service = new ReconciliationService(
    dataSource,
    reconRepo,
    balanceRepo,
    requestRepo,
    new FakeHcmReader(hcmTotals),
    closedBreaker(),
    audit,
    silentLogger,
  );
  return { dataSource, service, balanceRepo };
}

/** Snapshot of (total, reserved) per balance, for equivalence comparison. */
async function snapshot(dataSource: DataSource): Promise<Record<string, [number, number]>> {
  const balances = await dataSource.getRepository(Balance).find({ order: { id: 'ASC' } });
  return Object.fromEntries(balances.map((b) => [b.id, [b.totalDays, b.reservedDays]]));
}

/**
 * @req REQ-REC-05
 * @req INV-02
 */
describe('reconciliation idempotence and INV-02 under interleave (property-based)', () => {
  it('REQ-REC-05: reconciling the same corpus twice yields equivalent balance state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            localTotal: fc.integer({ min: 0, max: 30 }),
            reserved: fc.integer({ min: 0, max: 10 }),
            hcmTotal: fc.integer({ min: 0, max: 30 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (rows) => {
          // reserved cannot exceed local total at seed time (INV-02 holds pre-run).
          const locals = rows.map((r) => ({
            total: Math.max(r.localTotal, r.reserved),
            reserved: r.reserved,
          }));
          const hcmTotals = new Map(rows.map((r, i) => [`emp_${i}`, r.hcmTotal]));
          const harness = await makeHarness(locals, hcmTotals);
          try {
            await harness.service.runOnDemand();
            const afterFirst = await snapshot(harness.dataSource);
            await harness.service.runOnDemand();
            const afterSecond = await snapshot(harness.dataSource);
            expect(afterSecond).toEqual(afterFirst);
          } finally {
            await harness.dataSource.destroy();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * @req INV-01
   * @req INV-02
   * @req R-02
   */
  it('R-02: saga commit re-applying its delta over a reconciliation absolute write under-counts transiently, then the next reconciliation converges (INV-01/INV-02 hold throughout)', async () => {
    // Setup mirrors the hazard documented at the saga commit() OCC-retry
    // boundary: the employee has a SUBMITTED request reserving `days`, and HCM
    // has ALREADY absorbed the matching decrement (hcmTotal = startTotal - days).
    const startTotal = 20;
    const days = 3;
    const hcmTotal = startTotal - days; // HCM already reflects the decrement.
    const harness = await makeHarness(
      [{ total: startTotal, reserved: days }],
      new Map([['emp_0', hcmTotal]]),
    );
    const assertInvariants = async (): Promise<void> => {
      const b = await harness.dataSource.getRepository(Balance).findOneByOrFail({ id: 'bal_0' });
      expect(b.reservedDays).toBeGreaterThanOrEqual(0); // INV-01
      expect(b.totalDays - b.reservedDays).toBeGreaterThanOrEqual(0); // INV-02
    };

    try {
      await assertInvariants();

      // 1. Reconcile: the batch absolute write lands hcmTotal (already net of the
      //    decrement) into local total_days.
      await harness.service.runOnDemand();
      await assertInvariants();
      const afterRecon = await harness.dataSource
        .getRepository(Balance)
        .findOneByOrFail({ id: 'bal_0' });
      expect(afterRecon.totalDays).toBe(hcmTotal);

      // 2. Saga-style commit RE-APPLIES the fixed -days delta on top of the
      //    reconciled total: total/reserved -= days. This double-counts the
      //    decrement and transiently UNDER-counts local total_days.
      await harness.dataSource.transaction((manager) =>
        harness.balanceRepo.casCommit(
          afterRecon.id,
          afterRecon.version,
          -days,
          -days,
          'hcm_op_double',
          manager,
        ),
      );
      const afterCommit = await harness.dataSource
        .getRepository(Balance)
        .findOneByOrFail({ id: 'bal_0' });
      expect(afterCommit.totalDays).toBe(hcmTotal - days); // transient under-count
      await assertInvariants(); // INV-01/INV-02 still hold despite the under-count

      // 3. The NEXT reconciliation converges local total_days back to the HCM
      //    total. (Reserved is now 0, so the §9.3 batch write restores it.)
      await harness.service.runOnDemand();
      const afterConverge = await harness.dataSource
        .getRepository(Balance)
        .findOneByOrFail({ id: 'bal_0' });
      expect(afterConverge.totalDays).toBe(hcmTotal);
      // The SUBMITTED request still reserves `days`; the §9.3 batch write
      // reasserts reserved from sumReservedDays, so it returns to `days`.
      expect(afterConverge.reservedDays).toBe(days);
      await assertInvariants();
    } finally {
      await harness.dataSource.destroy();
    }
  });

  it('INV-02: point reconciliation interleaved with concurrent reservations never drives total - reserved < 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          localTotal: fc.integer({ min: 0, max: 20 }),
          reserved: fc.integer({ min: 0, max: 20 }),
          hcmTotal: fc.integer({ min: 0, max: 20 }),
          interleave: fc.array(fc.oneof(fc.constant('reconcile'), fc.constant('reserve')), {
            maxLength: 12,
          }),
        }),
        async ({ localTotal, reserved, hcmTotal, interleave }) => {
          const seedTotal = Math.max(localTotal, reserved);
          const harness = await makeHarness(
            [{ total: seedTotal, reserved }],
            new Map([['emp_0', hcmTotal]]),
          );
          try {
            for (const step of interleave) {
              if (step === 'reconcile') {
                await harness.service.reconcilePoint('emp_0', LOC);
              } else {
                // A concurrent reservation: bump reserved by 1 only when the
                // invariant still permits it (mirrors the submit guard, INV-02).
                const b = await harness.balanceRepo.findByEmployeeAndLocation('emp_0', LOC);
                if (b && b.totalDays - (b.reservedDays + 1) >= 0) {
                  // Back the row bump with a SUBMITTED request so sumReservedDays
                  // tracks row.reservedDays (INV-03). This is load-bearing under
                  // §9.7: the point path no longer overwrites reserved, so the
                  // applyDrift guard relies on sumReservedDays being truthful.
                  await harness.dataSource.getRepository(TimeOffRequest).insert({
                    id: `req_${randomUUID()}`,
                    employeeId: 'emp_0',
                    locationId: LOC,
                    startDate: '2026-07-01',
                    endDate: '2026-07-01',
                    daysRequested: 1,
                    status: 'SUBMITTED',
                    submittedAt: new Date(),
                  });
                  await harness.dataSource
                    .getRepository(Balance)
                    .update({ id: b.id }, { reservedDays: b.reservedDays + 1 });
                }
              }
              const cur = await harness.dataSource
                .getRepository(Balance)
                .findOneByOrFail({ id: 'bal_0' });
              expect(cur.totalDays - cur.reservedDays).toBeGreaterThanOrEqual(0);
            }
          } finally {
            await harness.dataSource.destroy();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

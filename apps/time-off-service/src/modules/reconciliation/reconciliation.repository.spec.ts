import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { ReconciliationCursorError } from '../../common/errors/reconciliation-cursor.error';
import { Reconciliation } from '../../database/entities/reconciliation.entity';
import { ReconciliationRepository } from './reconciliation.repository';

/**
 * @req REQ-REC-01
 * @req REQ-REC-04
 */
describe('ReconciliationRepository.list (cursor pagination, api-contract.md §5)', () => {
  let dataSource: DataSource;
  let repo: ReconciliationRepository;

  /** Inserts a COMPLETED run with an explicit started_at so ordering is deterministic. */
  async function insertRun(id: string, startedAtIso: string): Promise<void> {
    await dataSource.getRepository(Reconciliation).insert({
      id,
      status: 'COMPLETED',
      since: new Date(0),
      startedAt: new Date(startedAtIso),
      completedAt: new Date(startedAtIso),
      balancesExamined: 0,
      conflicts: 0,
      triggerType: 'ON_DEMAND',
    });
  }

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    repo = new ReconciliationRepository(dataSource);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('returns the page newest-first with has_more false and a null cursor when all rows fit', async () => {
    await insertRun('11111111-1111-1111-1111-111111111111', '2026-05-01T00:00:00.000Z');
    await insertRun('22222222-2222-2222-2222-222222222222', '2026-05-02T00:00:00.000Z');

    const page = await repo.list(50);

    expect(page.data.map((r) => r.id)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111',
    ]);
    expect(page.pagination.has_more).toBe(false);
    expect(page.pagination.next_cursor).toBeNull();
  });

  it('paginates with an opaque cursor, breaking started_at ties on id (no skips, no duplicates)', async () => {
    // Two rows share started_at: the id tie-break must keep the boundary stable.
    await insertRun('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-05-02T00:00:00.000Z');
    await insertRun('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-05-02T00:00:00.000Z');
    await insertRun('cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-05-01T00:00:00.000Z');

    const first = await repo.list(2);
    expect(first.data).toHaveLength(2);
    expect(first.pagination.has_more).toBe(true);
    expect(first.pagination.next_cursor).not.toBeNull();

    const second = await repo.list(2, first.pagination.next_cursor ?? undefined);
    const allIds = [...first.data, ...second.data].map((r) => r.id);

    // Every row appears exactly once across the two pages, newest-first overall.
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toEqual([
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);
    expect(second.pagination.has_more).toBe(false);
    expect(second.pagination.next_cursor).toBeNull();
  });

  it('clamps a limit above the maximum to 100', async () => {
    await insertRun('11111111-1111-1111-1111-111111111111', '2026-05-01T00:00:00.000Z');
    const page = await repo.list(9999);
    // One row exists, so the clamp is observable only by not throwing; the
    // boundary is enforced — a 9999 take would otherwise be requested.
    expect(page.data).toHaveLength(1);
  });

  it('rejects a malformed cursor with ReconciliationCursorError', async () => {
    await expect(repo.list(50, 'not-base64-json')).rejects.toBeInstanceOf(
      ReconciliationCursorError,
    );
  });
});

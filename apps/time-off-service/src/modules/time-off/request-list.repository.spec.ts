import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../../../../../test/support/db';
import { RequestCursorError } from '../../common/errors/request-cursor.error';
import { RequestRepository } from './request.repository';

/**
 * @req REQ-LIST-01
 * @req REQ-DEF-10
 */
describe('RequestRepository.list (keyset pagination)', () => {
  let dataSource: DataSource;
  let repo: RequestRepository;

  beforeEach(async () => {
    dataSource = await createTestDataSource();
    repo = new RequestRepository(dataSource);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seeds a request with controllable submitted_at (offset ms from epoch anchor). */
  async function seedRequest(
    id: string,
    employeeId: string,
    submittedAtMs: number,
    status: string = 'SUBMITTED',
  ): Promise<void> {
    await repo.insert(
      {
        id,
        employeeId,
        locationId: 'loc_001',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        daysRequested: 3,
        status: status as 'SUBMITTED',
        submittedAt: new Date(submittedAtMs),
      },
      dataSource.manager,
    );
  }

  it('returns empty page when no requests exist', async () => {
    const page = await repo.list(null, { limit: 20 });
    expect(page.data).toHaveLength(0);
    expect(page.pagination).toEqual({ next_cursor: null, has_more: false });
  });

  it('returns only the employee own requests when employeeId is provided', async () => {
    await seedRequest('req_001', 'emp_001', 1000);
    await seedRequest('req_002', 'emp_002', 2000);
    await seedRequest('req_003', 'emp_001', 3000);

    const page = await repo.list('emp_001', { limit: 20 });
    expect(page.data).toHaveLength(2);
    expect(page.data.every((r) => r.employeeId === 'emp_001')).toBe(true);
  });

  it('returns all requests when employeeId is null (admin)', async () => {
    await seedRequest('req_001', 'emp_001', 1000);
    await seedRequest('req_002', 'emp_002', 2000);
    await seedRequest('req_003', 'emp_001', 3000);

    const page = await repo.list(null, { limit: 20 });
    expect(page.data).toHaveLength(3);
  });

  it('sorts results newest-first by (submitted_at DESC, id DESC)', async () => {
    // Use same ms to exercise id tie-break
    const sameMs = 5000;
    await seedRequest('req_aaa', 'emp_001', sameMs);
    await seedRequest('req_zzz', 'emp_001', sameMs);
    await seedRequest('req_001', 'emp_001', 1000);

    const page = await repo.list(null, { limit: 20 });
    // req_zzz and req_aaa at same ms — id DESC means req_zzz first
    expect(page.data[0].id).toBe('req_zzz');
    expect(page.data[1].id).toBe('req_aaa');
    expect(page.data[2].id).toBe('req_001');
  });

  it('paginates: page 1 returns limit rows with has_more=true and next_cursor set', async () => {
    for (let i = 1; i <= 3; i++) {
      await seedRequest(`req_00${i}`, 'emp_001', i * 1000);
    }

    const page = await repo.list(null, { limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.pagination.has_more).toBe(true);
    expect(page.pagination.next_cursor).not.toBeNull();
  });

  it('paginates: page 2 (cursor from page 1) returns remaining rows with has_more=false', async () => {
    for (let i = 1; i <= 3; i++) {
      await seedRequest(`req_00${i}`, 'emp_001', i * 1000);
    }

    const page1 = await repo.list(null, { limit: 2 });
    const cursor = page1.pagination.next_cursor!;
    const page2 = await repo.list(null, { limit: 2, cursor });

    expect(page2.data).toHaveLength(1);
    expect(page2.pagination.has_more).toBe(false);
    expect(page2.pagination.next_cursor).toBeNull();
    // No overlap between pages
    const ids1 = page1.data.map((r) => r.id);
    const ids2 = page2.data.map((r) => r.id);
    expect(ids1.every((id) => !ids2.includes(id))).toBe(true);
  });

  it('exact page boundary: limit=2 with exactly 2 rows gives has_more=false', async () => {
    await seedRequest('req_001', 'emp_001', 1000);
    await seedRequest('req_002', 'emp_001', 2000);

    const page = await repo.list(null, { limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.pagination.has_more).toBe(false);
    expect(page.pagination.next_cursor).toBeNull();
  });

  it('filters by status when status is provided', async () => {
    await seedRequest('req_001', 'emp_001', 1000, 'SUBMITTED');
    await seedRequest('req_002', 'emp_001', 2000, 'APPROVED');
    await seedRequest('req_003', 'emp_001', 3000, 'SUBMITTED');

    const page = await repo.list(null, { limit: 20, status: 'SUBMITTED' });
    expect(page.data).toHaveLength(2);
    expect(page.data.every((r) => r.status === 'SUBMITTED')).toBe(true);
  });

  it('employee filter combined with status filter returns only matching rows', async () => {
    await seedRequest('req_001', 'emp_001', 1000, 'SUBMITTED');
    await seedRequest('req_002', 'emp_002', 2000, 'SUBMITTED');
    await seedRequest('req_003', 'emp_001', 3000, 'APPROVED');

    const page = await repo.list('emp_001', { limit: 20, status: 'SUBMITTED' });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe('req_001');
  });

  it('employee-scoped cursor does not leak other employees on page 2', async () => {
    // emp_001 has 3 requests; emp_002 has 1 request
    for (let i = 1; i <= 3; i++) {
      await seedRequest(`req_emp1_0${i}`, 'emp_001', i * 1000);
    }
    await seedRequest('req_emp2_01', 'emp_002', 2500);

    const page1 = await repo.list('emp_001', { limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.pagination.has_more).toBe(true);

    const page2 = await repo.list('emp_001', { limit: 2, cursor: page1.pagination.next_cursor! });
    expect(page2.data.every((r) => r.employeeId === 'emp_001')).toBe(true);
  });

  it('throws RequestCursorError for a malformed cursor', async () => {
    await expect(
      repo.list(null, { limit: 20, cursor: 'not-valid-base64-json' }),
    ).rejects.toBeInstanceOf(RequestCursorError);
  });

  it('throws RequestCursorError for a structurally invalid cursor (missing fields)', async () => {
    const bad = Buffer.from(JSON.stringify({ wrong: 'fields' }), 'utf8').toString('base64');
    await expect(repo.list(null, { limit: 20, cursor: bad })).rejects.toBeInstanceOf(
      RequestCursorError,
    );
  });

  it('throws RequestCursorError for a cursor with an invalid date', async () => {
    const bad = Buffer.from(
      JSON.stringify({ submittedAt: 'not-a-date', id: 'some-id' }),
      'utf8',
    ).toString('base64');
    await expect(repo.list(null, { limit: 20, cursor: bad })).rejects.toBeInstanceOf(
      RequestCursorError,
    );
  });
});

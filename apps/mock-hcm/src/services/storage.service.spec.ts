import { StorageService } from './storage.service';

/**
 * Storage seeds from the fixture, supports per-pair lookup, upsert, delta
 * application, and reset (mock-hcm.md §5).
 */
describe('StorageService', () => {
  const fixturePath = `${__dirname}/../../fixtures/balances.json`;

  beforeEach(() => {
    process.env.MOCK_HCM_FIXTURE_PATH = fixturePath;
  });

  afterEach(() => {
    delete process.env.MOCK_HCM_FIXTURE_PATH;
  });

  function newService(): StorageService {
    return new StorageService();
  }

  it('seeds balances from the fixture on construction', () => {
    const service = newService();

    expect(service.find('emp_001', 'loc_001')).toEqual({
      employee_id: 'emp_001',
      location_id: 'loc_001',
      total_days: 20,
      last_modified_at: '2026-01-01T00:00:00Z',
    });
  });

  it('returns all balance rows for an employee', () => {
    const service = newService();

    const rows = service.findByEmployee('emp_001');

    expect(rows).toEqual([
      {
        employee_id: 'emp_001',
        location_id: 'loc_001',
        total_days: 20,
        last_modified_at: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('returns an empty array for an unknown employee', () => {
    const service = newService();

    expect(service.findByEmployee('nobody')).toEqual([]);
  });

  it('returns undefined for an unknown pair', () => {
    const service = newService();

    expect(service.find('nobody', 'loc_001')).toBeUndefined();
  });

  it('upserts a balance, overwriting an existing pair', () => {
    const service = newService();

    service.upsert({
      employee_id: 'emp_001',
      location_id: 'loc_001',
      total_days: 99,
      last_modified_at: '2026-02-02T00:00:00Z',
    });

    expect(service.find('emp_001', 'loc_001')?.total_days).toBe(99);
  });

  it('applies a delta to the stored total and returns the new total', () => {
    const service = newService();

    const newTotal = service.applyDelta('emp_001', 'loc_001', -5);

    expect(newTotal).toBe(15);
    expect(service.find('emp_001', 'loc_001')?.total_days).toBe(15);
  });

  it('reset re-seeds storage from the fixture', () => {
    const service = newService();
    service.applyDelta('emp_001', 'loc_001', -5);

    service.reset();

    expect(service.find('emp_001', 'loc_001')?.total_days).toBe(20);
  });

  it('exposes a snapshot of all stored rows', () => {
    const service = newService();

    expect(service.snapshot()).toHaveLength(2);
  });

  it('drift mutates total_days while preserving last_modified_at', () => {
    const service = newService();
    const before = service.find('emp_001', 'loc_001');

    const total = service.drift('emp_001', 'loc_001', 7);

    expect(total).toBe(7);
    const after = service.find('emp_001', 'loc_001');
    expect(after?.total_days).toBe(7);
    expect(after?.last_modified_at).toBe(before?.last_modified_at);
  });

  it('drift throws for an unknown pair', () => {
    const service = newService();

    expect(() => service.drift('nobody', 'loc_001', 1)).toThrow();
  });

  describe('batchSince', () => {
    /** Seeds three rows across two distinct timestamps for ordering assertions. */
    function seeded(): StorageService {
      const service = newService();
      service.upsert({
        employee_id: 'emp_003',
        location_id: 'loc_001',
        total_days: 5,
        last_modified_at: '2026-03-01T00:00:00Z',
      });
      return service;
    }

    it('filters out rows modified before since', () => {
      const service = seeded();

      const page = service.batchSince(new Date('2026-02-01T00:00:00Z'), undefined, 50);

      expect(page.rows).toHaveLength(1);
      expect(page.rows[0].employee_id).toBe('emp_003');
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('orders by (last_modified_at, key) and breaks ties by key', () => {
      const service = seeded();

      const page = service.batchSince(new Date('2026-01-01T00:00:00Z'), undefined, 50);

      // emp_001 and emp_002 share a timestamp; key ascending orders them first,
      // then emp_003 at the later timestamp.
      expect(page.rows.map((r) => `${r.employee_id}:${r.location_id}`)).toEqual([
        'emp_001:loc_001',
        'emp_002:loc_001',
        'emp_003:loc_001',
      ]);
    });

    it('paginates across a timestamp tie one row at a time', () => {
      const service = seeded();

      const first = service.batchSince(new Date('2026-01-01T00:00:00Z'), undefined, 1);
      expect(first.rows.map((r) => r.employee_id)).toEqual(['emp_001']);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      const second = service.batchSince(
        new Date('2026-01-01T00:00:00Z'),
        first.nextCursor ?? undefined,
        1,
      );
      expect(second.rows.map((r) => r.employee_id)).toEqual(['emp_002']);
      expect(second.hasMore).toBe(true);

      const third = service.batchSince(
        new Date('2026-01-01T00:00:00Z'),
        second.nextCursor ?? undefined,
        1,
      );
      expect(third.rows.map((r) => r.employee_id)).toEqual(['emp_003']);
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();
    });

    it('clamps a limit above the maximum to 100', () => {
      const service = newService();

      const page = service.batchSince(new Date('2026-01-01T00:00:00Z'), undefined, 9999);

      // Only two fixture rows exist, but the clamp must not throw or overflow.
      expect(page.rows).toHaveLength(2);
      expect(page.hasMore).toBe(false);
    });

    it('rejects a malformed cursor', () => {
      const service = newService();

      expect(() =>
        service.batchSince(new Date('2026-01-01T00:00:00Z'), 'not-base64!!', 50),
      ).toThrow();
    });
  });
});

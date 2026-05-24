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
});

import { ScenarioService } from './scenario.service';

/**
 * Scope-aware scenario resolution (mock-hcm.md §3.1, §4). Most-specific scoped
 * match wins; otherwise the global scenario; otherwise `normal`. Endpoints
 * resolve independently.
 */
describe('ScenarioService', () => {
  function newService(): ScenarioService {
    return new ScenarioService();
  }

  it('defaults to normal for every endpoint', () => {
    const service = newService();

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('normal');
    expect(service.resolve('get_balance', 'emp_001', 'loc_001')).toBe('normal');
  });

  it('applies an unscoped scenario globally', () => {
    const service = newService();

    service.set({ endpoints: { adjust: 'ambiguous-success' } });

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('ambiguous-success');
    expect(service.resolve('adjust', 'emp_999', 'loc_999')).toBe('ambiguous-success');
  });

  it('resolves endpoints independently', () => {
    const service = newService();

    service.set({ endpoints: { adjust: 'unverifiable-success' } });

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('unverifiable-success');
    expect(service.resolve('get_balance', 'emp_001', 'loc_001')).toBe('normal');
  });

  it('applies a scoped scenario only to matching operations', () => {
    const service = newService();

    service.set({
      endpoints: { adjust: 'unverifiable-success' },
      scope: { employee_id: 'emp_001', location_id: 'loc_001' },
    });

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('unverifiable-success');
    expect(service.resolve('adjust', 'emp_002', 'loc_001')).toBe('normal');
  });

  it('matches an employee-only scope across locations', () => {
    const service = newService();

    service.set({
      endpoints: { adjust: 'ambiguous-success' },
      scope: { employee_id: 'emp_001' },
    });

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('ambiguous-success');
    expect(service.resolve('adjust', 'emp_001', 'loc_999')).toBe('ambiguous-success');
    expect(service.resolve('adjust', 'emp_002', 'loc_001')).toBe('normal');
  });

  it('prefers a more-specific scoped match over the global scenario', () => {
    const service = newService();

    service.set({ endpoints: { adjust: 'normal' } });
    service.set({
      endpoints: { adjust: 'unverifiable-success' },
      scope: { employee_id: 'emp_001' },
    });

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('unverifiable-success');
    expect(service.resolve('adjust', 'emp_002', 'loc_001')).toBe('normal');
  });

  it('reset clears all scenarios back to normal', () => {
    const service = newService();
    service.set({ endpoints: { adjust: 'ambiguous-success' } });

    service.reset();

    expect(service.resolve('adjust', 'emp_001', 'loc_001')).toBe('normal');
  });

  it('snapshot exposes recorded scenario assignments', () => {
    const service = newService();
    service.set({ endpoints: { adjust: 'ambiguous-success' } });

    expect(service.snapshot()).toHaveLength(1);
  });
});

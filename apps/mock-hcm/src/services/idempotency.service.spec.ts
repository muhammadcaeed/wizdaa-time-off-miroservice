import { IdempotencyService, type IdempotencyOutcome } from './idempotency.service';

/**
 * Idempotency cache (mock-hcm.md §6): same key + same body replays verbatim,
 * same key + different body is a 409, new key is a miss.
 */
describe('IdempotencyService', () => {
  const body = { employee_id: 'emp_001', location_id: 'loc_001', delta: -5 };
  const response = { new_total_days: 15, hcm_correlation_id: 'hcm_op_1' };

  function newService(): IdempotencyService {
    return new IdempotencyService();
  }

  it('returns a miss for an unseen key', () => {
    const service = newService();

    const result: IdempotencyOutcome = service.lookup('key-1', body);

    expect(result.kind).toBe('miss');
  });

  it('replays the stored response verbatim for the same key and body', () => {
    const service = newService();
    service.store('key-1', body, 200, response);

    const result = service.lookup('key-1', body);

    expect(result).toEqual({ kind: 'replay', status: 200, body: response });
  });

  it('treats reordered body keys as the same body', () => {
    const service = newService();
    service.store(
      'key-1',
      { delta: -5, location_id: 'loc_001', employee_id: 'emp_001' },
      200,
      response,
    );

    const result = service.lookup('key-1', body);

    expect(result.kind).toBe('replay');
  });

  it('reports a conflict for the same key with a different body', () => {
    const service = newService();
    service.store('key-1', body, 200, response);

    const result = service.lookup('key-1', { ...body, delta: -6 });

    expect(result.kind).toBe('conflict');
  });

  it('reset clears the cache', () => {
    const service = newService();
    service.store('key-1', body, 200, response);

    service.reset();

    expect(service.lookup('key-1', body).kind).toBe('miss');
  });

  it('exposes stored keys for state inspection', () => {
    const service = newService();
    service.store('key-1', body, 200, response);

    expect(service.keys()).toEqual(['key-1']);
  });
});

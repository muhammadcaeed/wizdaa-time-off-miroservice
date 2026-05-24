import { OccConflictError } from './occ-conflict.error';
import { withOccRetry } from './with-occ-retry';

/**
 * @req REQ-DEF-08
 */
describe('withOccRetry', () => {
  it('returns the result when the operation succeeds on the first attempt', async () => {
    let attempts = 0;
    const result = await withOccRetry(() => {
      attempts++;
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });

  it('retries on OccConflictError and succeeds before exhausting attempts', async () => {
    let attempts = 0;
    const result = await withOccRetry(() => {
      attempts++;
      return attempts < 3
        ? Promise.reject(new OccConflictError('balances', 'bal_1'))
        : Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('rethrows OccConflictError after the maximum number of attempts (3)', async () => {
    let attempts = 0;
    await expect(
      withOccRetry(() => {
        attempts++;
        return Promise.reject(new OccConflictError('balances', 'bal_1'));
      }),
    ).rejects.toBeInstanceOf(OccConflictError);

    expect(attempts).toBe(3);
  });

  it('does not retry errors that are not OccConflictError', async () => {
    let attempts = 0;
    await expect(
      withOccRetry(() => {
        attempts++;
        return Promise.reject(new Error('unrelated'));
      }),
    ).rejects.toThrow('unrelated');

    expect(attempts).toBe(1);
  });
});

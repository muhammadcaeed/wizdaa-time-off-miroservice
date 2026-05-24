import { Writable } from 'node:stream';
import pino from 'pino';

/**
 * Verifies that the pino `redact` configuration used in LoggerModule
 * correctly censors PII fields before serialisation.
 *
 * ## Redact path semantics (pino / fast-redact)
 *
 * | Path          | Matches                                      |
 * |---------------|----------------------------------------------|
 * | `req.body.X`  | `{ req: { body: { X: value } } }`           |
 * | `*.X`         | any object one level from the root that has X|
 *
 * Note: `*.X` does NOT match `{ X: value }` at the top level, nor does it
 * match deeply nested `{ a: { b: { X: value } } }`. These tests document the
 * exact coverage provided by the current config.
 *
 * @req REQ-PII-01
 */
describe('PII redaction config (pino fast-redact)', () => {
  /** Redact config identical to what is used in LoggerModule.forRootAsync. */
  const REDACT_CONFIG: { paths: string[]; censor: string } = {
    paths: [
      'req.body.email',
      'req.body.firstName',
      'req.body.lastName',
      '*.email',
      '*.firstName',
      '*.lastName',
    ],
    censor: '[REDACTED]',
  };

  function makeLogger(): { logger: pino.Logger; lines: () => string[] } {
    const captured: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc, cb) {
        captured.push(chunk.toString('utf8').trim());
        cb();
      },
    });
    const logger = pino({ level: 'trace', redact: REDACT_CONFIG }, dest);
    return { logger, lines: () => captured };
  }

  it('redacts req.body.email', () => {
    const { logger, lines } = makeLogger();
    logger.info({ req: { body: { email: 'user@example.com' } } }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect((parsed as { req: { body: { email: string } } }).req.body.email).toBe('[REDACTED]');
  });

  it('redacts req.body.firstName', () => {
    const { logger, lines } = makeLogger();
    logger.info({ req: { body: { firstName: 'Alice' } } }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect((parsed as { req: { body: { firstName: string } } }).req.body.firstName).toBe(
      '[REDACTED]',
    );
  });

  it('redacts req.body.lastName', () => {
    const { logger, lines } = makeLogger();
    logger.info({ req: { body: { lastName: 'Smith' } } }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect((parsed as { req: { body: { lastName: string } } }).req.body.lastName).toBe(
      '[REDACTED]',
    );
  });

  it('redacts email one level deep (*.email covers {employee: {email: ...}})', () => {
    const { logger, lines } = makeLogger();
    logger.info({ employee: { id: 'emp_001', email: 'emp@x.io' } }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    expect((parsed as { employee: { email: string } }).employee.email).toBe('[REDACTED]');
  });

  it('redacts firstName and lastName one level deep', () => {
    const { logger, lines } = makeLogger();
    logger.info({ employee: { id: 'emp_001', firstName: 'Alice', lastName: 'Smith' } }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    const emp = (parsed as { employee: { firstName: string; lastName: string } }).employee;
    expect(emp.firstName).toBe('[REDACTED]');
    expect(emp.lastName).toBe('[REDACTED]');
  });

  it('does NOT redact non-PII fields', () => {
    const { logger, lines } = makeLogger();
    logger.info({ employee: { id: 'emp_001', locationId: 'loc_001' } }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    const emp = (parsed as { employee: { id: string; locationId: string } }).employee;
    expect(emp.id).toBe('emp_001');
    expect(emp.locationId).toBe('loc_001');
  });

  it('documents coverage gap: *.email does NOT match top-level email field', () => {
    // This test documents current behaviour — not a bug to fix now, just
    // important to know. If the service ever logs { email: 'x' } at top level,
    // it won't be redacted by the current config. Add 'email' to redact paths
    // if that use case arises.
    const { logger, lines } = makeLogger();
    logger.info({ id: 'emp_001', email: 'user@example.com' }, 'test');
    const parsed = JSON.parse(lines()[0]) as Record<string, unknown>;
    // Top-level email is NOT redacted by '*.email'
    expect((parsed as { email: string }).email).toBe('user@example.com');
  });
});

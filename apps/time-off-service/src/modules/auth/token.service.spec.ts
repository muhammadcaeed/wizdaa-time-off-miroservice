import jwt from 'jsonwebtoken';
import { TokenService } from './token.service';

/**
 * @req REQ-DEF-10
 */
describe('TokenService (HS256 stub, ADR-003)', () => {
  const KEY = 'unit-test-signing-key';
  let service: TokenService;

  beforeEach(() => {
    service = new TokenService(KEY, 900);
  });

  it('signs a token that verifies back to the same sub and roles', () => {
    const token = service.sign({ sub: 'emp_001', roles: ['EMPLOYEE'] });
    const principal = service.verify(token);

    expect(principal.sub).toBe('emp_001');
    expect(principal.roles).toEqual(['EMPLOYEE']);
  });

  it('rejects a token signed with a different key', () => {
    const forged = jwt.sign({ sub: 'emp_001', roles: ['ADMIN'] }, 'wrong-key', {
      algorithm: 'HS256',
    });

    expect(() => service.verify(forged)).toThrow();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 'emp_001', roles: ['EMPLOYEE'] }, KEY, {
      algorithm: 'HS256',
      expiresIn: -10,
    });

    expect(() => service.verify(expired)).toThrow();
  });

  it('rejects a token whose payload is missing roles', () => {
    const noRoles = jwt.sign({ sub: 'emp_001' }, KEY, { algorithm: 'HS256' });

    expect(() => service.verify(noRoles)).toThrow();
  });
});

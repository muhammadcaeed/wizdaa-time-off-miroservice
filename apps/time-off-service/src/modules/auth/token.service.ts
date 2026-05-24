import jwt from 'jsonwebtoken';
import type { Principal, Role } from './principal';

const VALID_ROLES: readonly Role[] = ['EMPLOYEE', 'MANAGER', 'ADMIN'];

/**
 * HS256 JWT stub (ADR-003). Verifies signature and expiry, pins the algorithm
 * to HS256 (rejecting `alg:none` and RS/ES confusion), and narrows the payload
 * to a {@link Principal}. The OIDC/JWKS migration swaps this implementation
 * without changing the principal contract. Token minting (`sign`) backs the
 * seeded test users; production tokens originate upstream.
 */
export class TokenService {
  constructor(
    private readonly signingKey: string,
    private readonly lifetimeSeconds: number,
  ) {}

  sign(principal: Principal): string {
    return jwt.sign({ sub: principal.sub, roles: principal.roles }, this.signingKey, {
      algorithm: 'HS256',
      expiresIn: this.lifetimeSeconds,
    });
  }

  /**
   * Verifies and decodes a bearer token.
   * @throws Error when the signature, algorithm, expiry, or payload shape is invalid
   */
  verify(token: string): Principal {
    const decoded = jwt.verify(token, this.signingKey, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') {
      throw new Error('Malformed token payload');
    }

    const sub = decoded.sub;
    const roles = (decoded as { roles?: unknown }).roles;
    if (typeof sub !== 'string' || !Array.isArray(roles)) {
      throw new Error('Token missing sub or roles');
    }
    if (!roles.every((r): r is Role => VALID_ROLES.includes(r as Role))) {
      throw new Error('Token contains an unknown role');
    }

    return { sub, roles };
  }
}

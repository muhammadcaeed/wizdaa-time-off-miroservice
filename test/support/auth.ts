import jwt from 'jsonwebtoken';

export type Role = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';

/**
 * Mints an HS256 bearer token for tests using the same signing key the app
 * verifies with (process.env.JWT_SIGNING_KEY). Mirrors the seeded test users.
 */
export function mintToken(sub: string, roles: Role[]): string {
  const key = process.env.JWT_SIGNING_KEY ?? 'test-signing-key';
  return jwt.sign({ sub, roles }, key, { algorithm: 'HS256', expiresIn: 900 });
}

export function bearer(sub: string, roles: Role[]): string {
  return `Bearer ${mintToken(sub, roles)}`;
}

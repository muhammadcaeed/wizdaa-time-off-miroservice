/** The three RBAC roles (api-contract.md §3, TRD §13.1). */
export type Role = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';

/** The verified caller: `sub` is the employee id, `roles` compose by union. */
export interface Principal {
  sub: string;
  roles: Role[];
}

/** The most privileged role the principal holds, for audit `actor_type`. */
export function actorTypeOf(principal: Principal): Role {
  if (principal.roles.includes('ADMIN')) return 'ADMIN';
  if (principal.roles.includes('MANAGER')) return 'MANAGER';
  return 'EMPLOYEE';
}

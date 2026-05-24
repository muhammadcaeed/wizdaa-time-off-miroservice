import { SetMetadata } from '@nestjs/common';
import type { Role } from './principal';

export const ROLES_KEY = 'roles';

/** Restricts a route to callers holding at least one of the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

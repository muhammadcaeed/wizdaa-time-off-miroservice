import { SetMetadata } from '@nestjs/common';

/** Metadata key used by {@link JwtAuthGuard} to skip authentication. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as public — exempt from the global {@link JwtAuthGuard}.
 * The route is still subject to throttling and role checks (no-op when no
 * `@Roles()` decorator is present). Use on health and other unauthenticated
 * endpoints.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

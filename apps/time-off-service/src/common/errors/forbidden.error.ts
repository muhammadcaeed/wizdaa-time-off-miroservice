import { DomainError } from './domain-error';

/**
 * The caller is not permitted to act on the target resource. Used for both
 * "not authorized" and "resource does not exist" so the response cannot be used
 * to enumerate resources (REQ-DEF-10). Maps to 403 `/errors/forbidden`.
 */
export class ForbiddenError extends DomainError {
  readonly httpStatus = 403;
  readonly typeUri = '/errors/forbidden';

  constructor() {
    super('You do not have permission to perform this action');
  }
}

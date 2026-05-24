/**
 * Thrown by a repository CAS write when the optimistic version predicate
 * matches zero rows (a concurrent writer changed the row). Caught by
 * {@link withOccRetry} to drive the retry loop. See TRD §10.2, ADR-005.
 */
export class OccConflictError extends Error {
  constructor(
    readonly table: string,
    readonly id: string,
  ) {
    super(`Optimistic concurrency conflict on ${table} row ${id}`);
    this.name = 'OccConflictError';
  }
}

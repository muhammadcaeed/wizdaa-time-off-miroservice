/**
 * Base for typed domain exceptions. Each subtype maps to an HTTP status and a
 * stable `/errors/<slug>` type URI used by the exception filter. Throwing
 * strings is forbidden; handlers throw a DomainError subtype instead. The full
 * RFC 7807 envelope is layered on in a later cycle; this carries the contract.
 */
export abstract class DomainError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly typeUri: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

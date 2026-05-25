# ADR-003: JWT bearer stub for authentication

**Status**: Accepted

## Context

The brief doesn't require an auth design, but the service needs a credible principal/RBAC contract so the rest of the design (authorization predicates, audit actor capture, manager-of-owner checks) can be expressed concretely. Coupling to a specific identity provider for a take-home would be over-investment; coupling to nothing (header trust) would be uncreditable.

## Decision

JWT bearer tokens (HS256) carrying `sub`, `roles`, `iat`, `exp`. A global NestJS guard verifies signature and expiry before any controller code runs. The verified principal is attached to the request and consumed by controller-level RBAC guards. 15-minute lifetime; refresh sits with the upstream layer. The signing key is env-driven.

OIDC integration is the production extension: the guard becomes a JWKS-aware verifier; the token's `sub` and `roles` claims map directly to the existing principal model, with no changes elsewhere.

## Consequences

**Positive:**
- Standard mechanism with mature libraries
- Stateless verification
- Easy to test (mint a token, present as Bearer)
- Clear upgrade path to OIDC/RS256 with no application changes

**Negative:**
- HS256 is symmetric; production should use RS256 + JWKS (the OIDC migration)
- No token revocation in this stub; 15-minute lifetime bounds the blast radius
- No refresh tokens; upstream responsibility

## Alternatives Considered

1. **Header stubs (`x-employee-id`, `x-role`).** Trivially forgeable, no signature, doesn't demonstrate the contract. Rejected.

2. **Full OIDC/IdP integration.** Out of scope for a take-home, introduces a production-grade dependency the brief didn't ask for. Deferred as the production extension.

3. **API keys per consumer.** Don't carry user identity or map to the RBAC matrix. Rotation is harder than JWT expiry. Rejected.

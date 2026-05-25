# ADR-009: NestJS monorepo layout for service + mock HCM

**Status**: Accepted

## Context

The system ships two NestJS applications: the main time-off service and the standalone mock HCM (`mock-hcm.md` §7, which specifies `apps/mock-hcm/`). The original scaffold placed the single app at the repository root in `src/`. We needed a structure that hosts both apps, keeps their dependencies and DTOs independent (the mock deliberately does not share the service's validation logic), and matches NestJS's blessed approach for multiple apps.

## Decision

Use NestJS monorepo mode (`nest-cli.json` `"monorepo": true`). Both apps live under `apps/`:

- `apps/time-off-service/` — the main service (default project), moved out of root `src/`.
- `apps/mock-hcm/` — the standalone mock HCM (dev/test only).

Each app has its own `tsconfig.app.json` and `main.ts` entry. Build/start target a named project (`nest build time-off-service`, `nest start mock-hcm`). `CLAUDE.md`'s Layout block was updated to match.

## Consequences

**Positive:**
- Matches the `apps/mock-hcm/` path the mock spec already assumed.
- NestJS-standard for multiple apps; the CLI understands the project graph.
- Clean separation: independent DTOs and dependency surfaces per app.

**Negative:**
- More config surface (per-project tsconfig + nest-cli `projects`).
- Diverges from the single-`src/` layout the original CLAUDE.md illustrated (now reconciled).

## Alternatives Considered

1. **Keep main in `src/`, add `apps/mock-hcm/` as a second nest-cli project.** Less churn, but a non-standard split (one app at root, one under `apps/`) that confuses the CLI's default-project assumptions. Rejected in favor of the symmetric monorepo.
2. **Two separate repositories.** Maximal isolation, but the mock is a test fixture for this service; co-location keeps them versioned together. Rejected.

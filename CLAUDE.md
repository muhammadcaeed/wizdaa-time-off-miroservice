# Time-Off Microservice

NestJS + TypeScript + SQLite. Coordinates time-off with an external HCM. HCM is the source of truth; this service mirrors and reconciles defensively.

## Read first

Open the relevant document before designing or coding in that area:

- `docs/TRD.md`: design narrative, source of truth.
- `docs/PLAN.md`: cycles in order. One cycle per session, stop after.

## Stack

NestJS 11, TypeScript strict (no `any`), TypeORM with migrations checked in (`synchronize` is never enabled), SQLite file-backed (`better-sqlite3`) in WAL mode, Vitest + supertest + fast-check, class-validator + class-transformer, pino + nestjs-pino, `jsonwebtoken` (HS256 stub), `@nestjs/throttler`. Env validated at startup via a Joi schema (`@nestjs/config` `validationSchema`); missing or malformed required vars fail the boot.

## Layout

NestJS monorepo (`nest-cli.json` `monorepo` mode). Two applications under `apps/`

## YOU MUST follow these rules

### NestJS docs are the source

For any NestJS API (decorators, modules, providers, pipes, guards, interceptors, exception filters, lifecycle hooks, testing utilities), consult https://docs.nestjs.com/ before writing code. Same rule for TypeORM (https://typeorm.io/), class-validator, pino, fast-check, and Vitest. Training-data recall is stale; the docs are not.

### Think before coding

State assumptions out loud. If two interpretations are plausible, present both and let me pick. Ask when uncertain on architectural calls. Surface inconsistencies between the TRD, the plan, and what I asked for. Push back constructively when something looks wrong.

### Surgical changes

Touch only what the current cycle needs. Match existing style. If you see unrelated dead code, mention it; don't delete it. Don't reformat files you didn't otherwise touch.

### Verify after every change

Run `npm run typecheck && npm test && npm run lint` after every edit. If anything is red, stop and fix before continuing. Don't claim a cycle is done until tests pass cleanly and the cycle's acceptance criteria in `docs/PLAN.md` are observably true.

### Architectural decisions

TRD is the source of truth. Don't invent rules; if a behavior isn't specified, ask. Any architectural call not covered by the TRD requires a new ADR in `docs/trd/adr/` before code, following the Nygard format of the existing twelve.

### Scope discipline

One cycle per session. The cycle's stop condition in `docs/PLAN.md` is the stop condition. Each cycle's "Out of scope" list names which later cycle picks up the deferred work. If you find yourself pulling future scope in, stop and reconsider.

## Cycle workflow

Skip `/superpowers:brainstorm` and `/superpowers:write-plan`. The design lives in the TRD, the plan lives in `docs/PLAN.md`. Every cycle follows the seven phases below. Skip a phase, the cycle isn't done.

### 1. Read and map

After reading `CLAUDE.md`, `docs/PLAN.md` (active cycle), and the TRD/companion sections that cycle points to, list in writing:

- Which obra/superpowers skills apply (TDD, systematic-debugging, dispatching-parallel-agents, verification-before-completion).
- Which agency agents will be called and at which phase.
- Which sub-tasks are independent enough for parallel subagents.

### 2. Surface conflicts

Name inconsistencies between CLAUDE.md, the TRD, the active cycle's plan, and prior-cycle code. Ask before resolving.

### 3. Design consultation

For any decision the cycle doesn't already settle (saga sequencing, retry policy, indexes, breaker thresholds, anything you'd otherwise guess on):

- Call `/advisor` (Opus) for the technical consult.
- Activate the **Software Architect** agency agent in parallel to review the same approach for trade-offs and design principles.
- Reconcile the two recommendations. Surface any divergence to me.

Non-obvious recommendation? Write ADR-N+1 in `docs/trd/adr/` before any code.

### 4. Approval gate

State back: one-paragraph plan, agent/skill map, parallelization plan, ADRs to be written, PR strategy (one or many). Wait for my go-ahead. No code before this point.

### 5. Parallel implementation

Parallelization is the default; sequential work is the exception you justified in phase 1. Use `obra/superpowers:dispatching-parallel-agents`, one git worktree per agent:

```bash
git worktree add ../<repo>-cycle-NN-<subtask> -b cycle-NN-<subtask>
```

Each subagent:

- Activates the **Backend Architect** persona for module and code-level design inside its worktree.
- Uses `test-driven-development` for every behavioral test.
- Uses `systematic-debugging` when stuck past one retry.
- Commits atomically per CLAUDE.md format.

Integrate sub-task branches into `cycle-NN-<slug>` with merge commits. Clean worktrees with `git worktree remove`.

### 6. Pre-PR review

On the integration branch, in order:

1. **Database Optimizer** if the cycle touched schema, indexes, or query plans.
2. **Security Engineer** if it touched auth, RBAC, validation, PII, or the network.
3. **API Tester** if it changed any HTTP contract or e2e path.
4. **Code Reviewer** (always).
5. **Reality Checker** final "is this actually done" gate (always).
6. `verification-before-completion` as the last check.

Resolve every finding before opening the PR.

### 7. Pull request

Use the template under "Commits and pull requests" below. Branch: `cycle-NN-<slug>`. Merge commit.

## Coding practices

### Design principles, applied pragmatically

- **KISS / YAGNI**: minimum code that passes the failing test. No speculative classes, flags, or error handling for impossible cases.
- **DRY, rule of three**: extract on the third duplicate, not the first. Premature DRY beats duplication only when the abstraction's name is obvious.
- **SOLID**: SRP (one reason to change), OCP (extend through new providers/strategies, don't edit), LSP (substitutable subtypes), ISP (small focused interfaces like `Reads`, `Writes`), DIP (depend on abstractions; DI handles wiring).
- **Thin abstractions**: wrap a library only when our behavior diverges from it (HCM client wraps because of retry + breaker + arithmetic check; the logger doesn't need a wrapper).
- **Reusable when reused**: generalize on the second caller, not the first.

### Concrete TypeScript / NestJS rules

- Constructor DI for every dependency.
- DTOs validated by `class-validator` on every HTTP boundary (whitelist + `forbidNonWhitelisted`).
- Typed exceptions mapped to HTTP via a filter. Never throw strings.
- Pino logger via DI. No `console.log` in `src/`.
- Async/await only. No `.then()` chains, no mixing.
- Named constants for meaningful literals (timeouts, retry counts, status strings).

### Documentation

- JSDoc on every public method of a service, every controller route, and every published interface. One-line summary, `@param` per arg, `@returns`, `@throws` for documented domain exceptions, `@req REQ-XX-NN` on test `describe` blocks.
- Inline comments explain **why**, not **what**. If a comment is needed to understand a line, rename a variable or extract a function first.
- ADRs capture decisions. README captures setup. CLAUDE.md captures rules. Each in its place.

## Commits and pull requests

A reviewer (and a recruiter) will read the history. Treat it as a deliverable.

### Commits

Conventional Commits. One logical change per commit. Caveman-terse subject, informative body.

- Subject: `<type>(<scope>): <imperative summary>`, under 60 chars. Types: `feat fix refactor test docs chore perf`.
- Body: 2-5 short lines on the **why**, plus cycle + REQ-IDs.
- Never commit broken code.


### Pull requests

One PR per plan when it fits; split when the plan has independently-shippable slices (e.g. plan 03's retry policy and circuit breaker as two PRs). A PR never spans multiple plans.

Mergeable when: feature complete, `typecheck + test + lint` green, cycle acceptance criteria in `docs/PLAN.md` observably true, coverage non-regressed.

Branch: `cycle-NN-<slug>`. Merge commit (preserves atomic history; reviewers see each well-formed commit).


## Skills and agents

Installed: obra/superpowers (auto-trigger), caveman (output style, always on), agency-agents (invoke by name).

Default model: Sonnet. Hard problems (TRD §10.3 concurrency, reconciliation, §11.1 failure modes) get `/advisor` (Opus) before code. Opus consults; Sonnet executes.

Agency agents to call by name:

- **Backend Architect**: API surface, module decomposition, data layer trade-offs.
- **Database Optimizer**: indexes, OCC queries, reconciliation SQL.
- **Code Reviewer**: end-of-cycle review before commit.
- **Security Engineer**: JWT + RBAC, input validation, PII redaction.
- **API Tester**: e2e + contract test planning.
- **Reality Checker**: final "is this actually done" gate.
- **Software Architect**: hard trade-offs; pairs with `/advisor` in the design phase.
- **Technical Writer**: ADRs, README, public docs.

If the agent isn't obvious, ask.

## Repo etiquette

Migrations are checked in; never edit a committed migration, add a new one. Never commit `.env`; `.env.example` is the contract. Don't commit generated files (`dist/`, `coverage/`). `docs/` is gitignored (intentional). Read from it; write to it freely; don't commit it.

## Rules added over time

Append rules here when Claude trips on something more than once. Format: `- short rule, link to commit or file where it bit us`.
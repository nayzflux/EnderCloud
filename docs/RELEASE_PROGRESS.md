# Release refactor progress

Source: [reliability audit](AUDIT_FIABILITE_2026-10-21.md). This work includes both the full release refactor and all fourteen audit findings.

## Baseline

- Branch: `codex/release-refactor`; no push is authorized or planned.
- Backend: 80 unit tests, TypeScript passing. The supplied audit records 57 PostgreSQL integration tests passing.
- Dashboard: 63 unit tests, lint and TypeScript passing.
- Website: lint passing; TypeScript passes after `next typegen` (missing from its check script).
- Compose configurations validate. Docker access and JDK availability must be verified for final checks.
- Preserve the local deletion of `docs/REFACTOR.md`; exclude `.cache/` from commits.

## Accepted design

- Bun workspace; separate orchestrator, agent, dashboard and website applications; shared contracts and server runtime utilities; Gradle plugins.
- One active orchestrator, PostgreSQL authoritative, host-local agent journal, independent Docker images.
- Fresh release database with explicit rejection of legacy databases; never automatically delete existing data.
- Local administrator authentication, scoped machine credentials, protected dashboard, private control network.
- Preserve functional behavior and visual design; remove obsolete compatibility code.

## Work queue

1. Worker rejection containment (audit 4).
2. Transactional failure accounting and durable event outbox (2).
3. Probe recovery and persistent deadline (1).
4. Session recovery races (5), offline reconciliation (6), logical recovery during cleanup (7), retained runtime stop retries (8).
5. Persistent agent operation generations and serialization (3).
6. Application health lease (9), bounded template pipelines (10), truthful loop supervision (12).
7. Ordered Paper assignments (11), versioned Velocity registry (13), fenced player transfers (14).
8. Workspaces, package boundaries, shared contracts, typed transactions, domain modules.
9. Configuration, lifecycle and HTTP cleanup; administrator and service authentication.
10. Fresh schema, legacy removal, dashboard/website organization, canonical docs, deployment, installer and CI.

Each implementation commit includes focused validation. Record completed work, design deviations and validation limits below; do not declare release readiness while required checks remain unexecuted.

## Implementation results

- Audit 4: startup tasks contain rejected operations and retain failed recovery writes until PostgreSQL accepts them. Persistent command retry deadline prevents a hot retry loop. Validation: backend TypeScript and 81 unit tests pass.
- Docker daemon is reachable outside the filesystem sandbox; integration tests use explicitly escalated commands and disposable Testcontainers databases.
- Audits 1/2: probe deadlines and infrastructure recovery; transactional failure accounting and an at-least-once registry outbox. Focused PostgreSQL scenarios pass, including Redis failure and revision replacement.
- Audits 5/7: recovery locks and rereads sessions and players; cancellation is preserved and recovery proceeds during physical STOPPING without releasing physical reservations. PostgreSQL regressions pass.
- Audits 6/8: offline instance transitions retry every reconciliation; retained diagnostic runtimes retry stop independently of file retention. Targeted SQL and unit checks pass.
- Audit 3: persistent SQLite operation journal serializes each instance and fences delayed CREATEs after STOP/DELETE, including across restart. Fixed generations 1=create, 2=stop, 3=delete are sufficient because instance ids are never reused. Contradictory CREATE specifications fail explicitly.
- Audits 9/12: configurable 30s Paper health lease plus 30s confirmation, routing withdrawal and terminal-state protection; partial loop failures propagate as AggregateError without skipping independent stages. Targeted checks pass.
- Audit 10 and configuration: bounded/abortable downloads, idle watchdog, concurrency/size/entry quotas, startup staging cleanup, cache integrity repair; streamed, framed v2 template checksums with deterministic ordering; duplicate group and numeric bound checks. Backend TypeScript and 87 unit tests pass.
- Audit 11: single-flight Paper assignment refresh, request/revision ordering, session-scoped acknowledgements. Paper compilation and two JUnit regressions pass in a disposable JDK 25 container.
- Audits 13/14: registry protocol v2 with ordered outbox revisions and buffered Velocity snapshots; persistent per-player transfer generations, wire expirations, source checks and abandonment receipts. PostgreSQL regressions pass; final coordinated Java validation is running.

## Remaining release work

The workspace/package extraction, domain service decomposition, shared Zod schemas, lifecycle/HTTP cleanup, authentication, fresh schema, canonical documentation, frontend organization and final deployment/CI validation are still required. Existing passing checks do not yet establish release readiness.

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

Pending.

# Release refactor — implementation and validation

The complete refactor and all fourteen findings from [the original audit](AUDIT_FIABILITE_2026-10-21.md)
are implemented on `codex/release-refactor`. The audit is preserved verbatim in `875e25e`.
All commits are local; nothing has been pushed. Existing user data was not deployed, migrated or deleted.

## Delivered architecture

- One Bun 1.4.2 workspace and lockfile; independent orchestrator, agent, dashboard and web applications.
  Each application owns its dependencies, entrypoint, configuration, checks and Docker image.
- Browser-safe shared contracts, Zod schemas, HTTP errors and transport in `packages/contracts`;
  common server utilities in `packages/runtime`. Transitive import checks forbid application-to-application
  production imports and server dependencies in browser code.
- Central domain modules for configuration, capacity, hosts, instances, sessions, matchmaking,
  transfers, proxies, monitoring and dashboard projections. SQL transactions and row results are typed;
  persisted CREATE snapshots are validated instead of reconstructed through historical fallbacks.
- A Docker-only agent with a durable SQLite operation journal, local ports/files/cache and no
  PostgreSQL, Redis or central configuration dependency.
- A testable resource-owning bootstrap, bounded idempotent shutdown and a PostgreSQL session lock
  permitting only one active orchestrator per database.
- One initial release schema. Empty databases initialize; existing release databases reopen;
  legacy databases are refused without modification. No automatic migration or deletion of legacy data.
- Better Auth and Drizzle administrator sessions, local creation/reset commands, no public registration,
  secure cookies in HTTPS, origin checks and persisted sign-in rate limits. Session polling remains
  independent of the sign-in quota.
- Per-host and per-instance service keys, independent agent control tokens, AES-256-GCM encrypted
  recoverable secrets, resource binding, rotation and revocation. A service key cannot open an administrator session.
- Authenticated dashboard pages and API routes, including demo mode; feature-based component organization,
  cancellable requests and preserved existing views. The public site reads canonical `docs/guides/`
  sources directly through Fumadocs.
- Pinned Java dependencies, locks and SHA-256 verification; updated TypeScript, Java, OpenAPI schemas
  and protocol fixtures. Next.js builds and starts from a fresh workspace with generated route types.
- Private control-network Compose, separated Redis publisher/subscriber ACLs, credential-aware Linux installer,
  HTTPS reverse-proxy example, production image checks and a pinned CI workflow.

## Audit coverage

| Audit | Implemented behavior                                                                                                                                                                                        | Main verification                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1     | Persisted probe deadline and reconciliation; infrastructure interruption releases the probe without consuming a variant retry.                                                                              | PostgreSQL probe recovery and reset scenarios                                      |
| 2     | Failure transition, idempotent accounting and registry outbox commit together; publication is resumed after commit and tolerates duplicates. Ready transitions use the same consistency boundary.           | Redis outage, repeated failure and registry revision regressions                   |
| 3     | Per-instance serialization, irreversible operation generations and durable SQLite deletion fences reject delayed CREATEs after restart.                                                                     | Journal reopen/concurrency tests and real two-agent Docker restart                 |
| 4     | The worker contains rejections from the first read onward and retains recoverable commands until persistence succeeds.                                                                                      | Worker rejection/claim/shutdown and SQL outage injection tests                     |
| 5     | Session recovery locks and rereads the session, instance and players; writes require the expected state and assignment.                                                                                     | PostgreSQL cancellation, assignment and recovery races                             |
| 6     | Every reconciliation retries instances belonging to offline hosts; routing excludes those hosts.                                                                                                            | Failed-transition retry and registry tests                                         |
| 7     | Logical recovery proceeds during physical cleanup, including STOPPING with a persisted failure cause.                                                                                                       | Session recovery and reservation retention scenarios                               |
| 8     | Diagnostic retention is separate from container stopping; stop/delete attempts repeat until physical confirmation.                                                                                          | Retained-runtime and physical-cleanup regressions                                  |
| 9     | Paper health has a persisted 30-second lease and 30-second confirmation by default; grace recovery cannot revive a terminal instance.                                                                       | Lease withdrawal, grace return and late-heartbeat tests                            |
| 10    | Total deadlines include queueing, download, extraction and hashing; idle transfers abort, staging is cleaned and cache hits are reverified under quotas. Transport failures are recoverable infrastructure. | Agent cancellation, corruption, traversal, idle timeout, transport and quota tests |
| 11    | Paper refresh is single-flight and ordered by request/session/revision, including empty responses and scoped acknowledgements.                                                                              | Paper AssignmentTracker JUnit regressions                                          |
| 12    | Independent loop stages continue but aggregate failures; a partial success cannot clear a persistent incident.                                                                                              | Loop failure and incident tests                                                    |
| 13    | Velocity buffers events while loading a centralized snapshot and uses the registry's monotone revision.                                                                                                     | Registry snapshot, reconnect and ordering JUnit tests                              |
| 14    | Transfers validate source and expiry, persist player generations and record abandonment of superseded work.                                                                                                 | PostgreSQL transfer receipts and Velocity TransferFence tests                      |

## Additional corrections found during implementation

- A SQL outage after remote CREATE used to be classified as a variant failure. Only remote execution
  is now inside that failure boundary; both remote success and remote failure can be replayed after a
  failed SQL commit. Command failure, instance failure, accounting and outbox writes share the transaction.
- Native agent infrastructure failures, template-service outages, stalled downloads, expired credentials
  and superseded operations have explicit HTTP/domain classifications.
- Image references distinguish a registry port from an image tag and validate pinned digests.
  Missing descriptor permissions are no longer swallowed as absent files.
- Shared template consumers cancel independently; only the last cancelled consumer aborts the shared transfer.
  Cache inspection and queue waiting are included in cancellation/deadline enforcement.
- Dashboard polling cannot exhaust the sign-in limiter; a regression performs 110 authenticated
  session validations while repeated failed logins remain limited.
- Integration tests always use disposable containers and cannot truncate a database supplied through
  `TEST_DATABASE_URL`.
- Container smoke tests reread dynamically mapped Docker ports after restart. Browser accessibility
  checks use bounded parallelism and a budget suitable for scanning three complete pages.

## Design choices and deviations

- Agent generations are fixed phases: 1=CREATE, 2=STOP, 3=DELETE. Instance identifiers are never reused,
  so retries retain the same immutable specification and cannot advance back to CREATE.
- Runtime key rotation retires the old instance identity and provisions a replacement through normal
  recovery; it never rewrites an already admitted CREATE with a different token.
- Audits 5/7 and 6/8 were grouped by their shared recovery/reconciliation consistency boundaries.
- Velocity's exact timestamped API/Brigadier artifacts are excluded from Gradle's alias-based snapshot
  locking because Gradle otherwise records conflicting base SNAPSHOT versions. Their exact coordinates
  and SHA-256 verification remain mandatory. All other dependencies are locked.
- Documentation compatibility filenames contain links to canonical guides rather than duplicate content.
  Protocol/database compatibility with the legacy release is deliberately refused.

## Validation evidence

Completed locally on 2026-10-21: `bun run check:release` exited with status 0 and
`All requested checks passed.` The full console log is retained locally in
`.cache/release-complete.log` (ignored by Git).

| Validation                                                                 | Result                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tooling, all six workspace types, import boundaries, canonical guide links | Passed                                                               |
| Repository formatting and both frontend lint suites                        | Passed                                                               |
| Orchestrator unit suite                                                    | 73 passed                                                            |
| Agent unit suite                                                           | 26 passed                                                            |
| Dashboard unit suite                                                       | 67 passed                                                            |
| Disposable PostgreSQL and Redis integration suite                          | 77 passed, 590 assertions                                            |
| Compose configurations and Linux installer                                 | Passed                                                               |
| Java 25 strict dependency verification and plugin JAR build                | Passed; 20 JUnit checks across core, Paper and Velocity, no failures |
| Production Docker images                                                   | All four built successfully                                          |
| Production-image startup and persisted-session smoke                       | Passed                                                               |
| Two real authenticated agents, restart and stale CREATE rejection          | Passed                                                               |
| Dashboard desktop/mobile Chromium                                          | 39 passed; 7 intentionally skipped for the opposite viewport         |
| Website desktop/mobile Chromium, search and accessibility                  | 6 passed                                                             |

Both browser suites completed without retries in this local run. The seven dashboard skips
are viewport-specific cases, not missing release scenarios.

The release command checks tooling types, application/package types, import boundaries, canonical
documentation links, formatting, frontend lint and unit suites. It then validates Compose, runs disposable
PostgreSQL/Redis integration tests, tests the Linux installer, builds Java with strict dependency verification,
builds all four production images, exercises production entrypoints and two-agent recovery, and runs
desktop/mobile browser suites.

Production-image checks cover empty-schema initialization, administrator creation, anonymous-route
rejection, authenticated dashboard access, persisted sessions after restart, non-root frontend processes,
canonical guide rendering and documentation search.

The two-agent smoke uses actual Docker agents, authenticated HTTP, template download/materialization,
PostgreSQL and Redis. It restarts the control plane and an agent, rejects an old CREATE after deletion
and confirms physical cleanup before reservations are released.

## Validation limits

- The two-agent test runs on one Docker daemon with lightweight runtimes and simulated Paper callbacks.
  It does not establish physical cross-host networking or Minecraft client/game compatibility.
- Actual Java 25 compilation, JUnit checks and plugin JAR builds are covered. The optional live Paper/Velocity
  smoke requires supplied fixed server JARs; it was not run because those deployment artifacts are absent.
- The CI workflow is implemented and its commands are executed locally. No remote CI run or publication
  was triggered, consistent with the no-push instruction.
- Existing legacy data remains untouched. A separate explicit data migration is required before adopting
  this release on a legacy database.
- The user's pre-existing local deletion of `docs/REFACTOR.md` remains uncommitted. `.cache/` and all
  generated credentials, browser artifacts and runtime files remain outside commits.

## Commit history

The local history is incremental, beginning with `875e25e`. Main milestones:

| Commits                         | Scope                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `3f1cbce`–`b64d6f0`             | Fourteen reliability findings and coordinated protocol changes                      |
| `5c1e11d`, `b377a7b`            | Workspace separation and domain decomposition                                       |
| `f6be390`, `df5cbe9`, `2251dc9` | Administrator/service authentication, dashboard protection and identity retirement  |
| `9a26c1f`, `8c99f56`, `ba21d26` | Startup/shutdown ownership, transaction ordering and SQL-failure replay             |
| `1d55b2c`, `7c1dbf3`, `eb8a5bf` | Legacy removal, cache cancellation and transitive package boundaries                |
| `381a3e9`, `1bcde4b`            | Verified Java dependencies and dashboard feature organization                       |
| `c357aa4`, `998093a`, `ff875ba` | Deployment/ACLs, canonical documentation and consistent formatting                  |
| `0050535`, `349ffe6`            | Session polling and template transport failure classification                       |
| `fdf7767`, `17d718d`            | Production image configuration, complete release command, Docker smoke tests and CI |

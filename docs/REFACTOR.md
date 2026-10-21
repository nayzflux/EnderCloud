# Release preparation audit

This audit records the findings before implementation. The target remains a modular control
plane with independent host agents and a separate dashboard. Existing HTTP payloads, database
migrations and Java plugin contracts must remain compatible.

## Findings

| Priority | Evidence | Proposed change |
| --- | --- | --- |
| High | `orchestrator/src/agent/` and `executor/local-docker.ts` share the orchestrator package and image; both processes install PostgreSQL, Redis and Docker dependencies. | Give the agent its own package, entry point, tests and Docker image. Keep Docker exclusively in the agent. |
| High | The agent imports `configuration/sync.ts` for directory inspection, pulling database and YAML concerns into host execution. | Extract filesystem inspection into a small shared runtime package with no database dependencies. |
| High | Dashboard DTOs and lifecycle enums are copied between the dashboard and orchestrator. | Make `contracts/` a workspace package; import one definition from all TypeScript consumers and retain Java fixtures. |
| High | Startup only closes resources around the initial convergence pass; configuration sync, Redis connection and migration failures can leak connections. Agent shutdown does not await its active heartbeat. | Extract testable startup composition and use ordered, idempotent resource cleanup on every failure path. |
| High | API status codes depend on a regular expression over error messages. Unknown routes become 500; the agent treats invalid host/path combinations as server failures. | Use explicit application errors and consistent mappings for invalid input, missing routes and conflicts. |
| High | Template downloads have no deadline; cache hits trust directories without verification; directory inspection reads entire files into memory. | Bound downloads, verify cached content, stream file hashing and test corrupt/unsafe archives. Preserve the checksum algorithm for compatibility. |
| Medium | Configuration parsing, filesystem loading and database synchronization live together in a 664-line module. | Separate descriptor parsing, loading/validation and persistence. Enforce safe numeric bounds and duplicate group detection. |
| Medium | Dashboard proxy always constructs a string body, including for 204 responses, which the Response API rejects. Browser GET/POST error parsing is duplicated. | Centralize browser requests and handle bodyless upstream responses explicitly, with regression tests. |
| Medium | Three independent Bun lockfiles, no root validation command and `next: latest` make repository operations inconsistent. | Use one Bun workspace and lockfile, explicit framework versions and root validation commands. |
| Medium | Compose and the interactive installer assume the combined agent/orchestrator image. | Update every build context and command together; validate generated deployment configurations. |
| Medium | Legacy fallback identifiers still support already-persisted session data. | Keep migration/data compatibility; remove obsolete source entry points and duplicated definitions rather than deleting recovery paths blindly. |

## Implementation sequence

1. Commit the audit and baseline observations.
2. Establish workspaces, extract shared contracts/runtime, separate the agent, and update deployment builds.
3. Split configuration responsibilities and fix invalid/ambiguous configuration edge cases.
4. Make application startup and shutdown reliable and testable.
5. Replace HTTP error heuristics and harden the dashboard HTTP boundary.
6. Harden template caching and streaming, with focused regression tests.
7. Add repository boundary checks, update development/deployment documentation and record validation.

Each implementation commit must include its relevant checks. No push is part of this work.

## Baseline and release limits

- The checkout was clean on `main` at `4b08270`.
- Bun 1.4.2 and Node 24.13.0 are available. Dependencies were absent at audit time.
- Installing dependencies requires execution outside the filesystem sandbox on this Windows host
  (Bun reports `EBADF accessing temporary directory` inside it).
- Docker's named pipe initially returns permission denied. Integration tests and image validation
  require a usable Docker daemon; unit tests alone do not establish release readiness.
- No authentication exists on the private control APIs. Packaging cleanup does not turn the
  current private-network deployment into a public authenticated service.
- Existing database migrations are immutable. Cleanup must retain recovery of historical records.

## Validation results

Implementation results and remaining release checks are recorded here as the work progresses.

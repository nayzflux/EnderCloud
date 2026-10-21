# Workspace layout

Install once at the repository root with `bun install --frozen-lockfile` (Bun 1.4.2).

| Workspace            | Responsibility                                                                  |
| -------------------- | ------------------------------------------------------------------------------- |
| `apps/orchestrator`  | PostgreSQL control plane, Redis publication, configuration and HTTP API         |
| `apps/agent`         | Docker, local files, immutable template cache and SQLite operation journal      |
| `apps/dashboard`     | Next.js operations console and server-side orchestrator proxy                   |
| `apps/web`           | Public website and documentation                                                |
| `packages/contracts` | Browser-safe protocol, domain enums and dashboard DTOs                          |
| `packages/runtime`   | Shared server logging, environment parsing, identifiers and template inspection |
| `plugins`            | Gradle build for core, Paper and Velocity                                       |
| `contracts/fixtures` | JSON fixtures consumed by TypeScript and Java                                   |

Run `bun run check` for package-boundary checks, canonical documentation links, types, formatter, frontend lint and unit tests. `bun run typecheck` and `bun test` are not interchangeable: use `bun run test` for the root unit suite. The root `test` script deliberately excludes PostgreSQL integration tests.

`bun run check:release` also builds all four Docker images, runs browser and PostgreSQL/Redis integration tests, tests the Linux installer, builds the Java plugins with strict dependency verification and exercises production entrypoints plus two authenticated agents through restart. It requires Docker and Chromium. Java uses JDK 25 locally or a JDK 25 Docker fallback; Windows installer checks use a Linux Docker container. CI supplies browser system dependencies; missing prerequisites do not count as successful validation.

Development commands are available as `bun run dev:orchestrator`, `dev:agent`, `dev:dashboard` and `dev:web`. Production processes still require the configuration described in the component guides. The default group and template directories resolve relative to the repository rather than the process working directory.

Every Docker image builds from the repository root and installs only its selected application graph. The orchestrator has no Docker runtime dependency; Docker packages used by its integration/smoke tests are development dependencies. The agent has no PostgreSQL, Redis or YAML dependency.

The source boundary checker forbids production imports between applications and server imports in contracts. Cross-application integration test harnesses are allowed to exercise the HTTP boundary.

Next.js generates its route declarations before TypeScript validation. Shared packages are compiled from TypeScript sources by their consuming application.

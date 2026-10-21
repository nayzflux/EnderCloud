# EnderCloud dashboard

The dashboard is a Next.js operations console for one EnderCloud cluster. It reads the central
orchestrator through server-side proxy routes, so the browser never needs the private orchestrator
URL.

The application uses React 19, Next.js 16, TanStack Query, React Flow, Recharts, Tailwind CSS, and
shadcn/ui.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Fleet summary, lifecycle distribution, group capacity, host health, and current problems |
| `/groups` | Group type, capacity, routing or matchmaking policy, timeouts, and variant count |
| `/groups/[groupId]/variants` | Ordered template layers, effective Docker settings, revisions, file summaries, and startup status |
| `/hosts` | Agent health, administration state, resource reservations, drain, and activation |
| `/instances` | Filterable instance table and detailed lifecycle panel |
| `/sessions` | Matchmaking sessions, assigned instance, players, profiles, and transfer progress |
| `/queues` | Queue pressure, wait-time distribution, and oldest parties by minigame group |
| `/topology` | React Flow graph connecting groups, warm pools, instances, and sessions |
| `/monitoring` | Startup readiness and Paper TPS time series grouped by variant |
| `/incidents` | Active and resolved operational incidents with kind, severity, scope, and evidence |

Selecting an instance or session opens the same detail panel wherever the record appears. The
panel shows players, commands, events, profiles, transfers, lifecycle steps, and the one active
deadline selected by the orchestrator.

The Hosts page requires confirmation before drain or activation. A blocked variant revision can
also request a startup-policy reset from its group variant page. These actions call dashboard
server routes, which forward them to the orchestrator.

## Data flow

Browser components call local routes under `src/app/api/`. Those server routes either proxy the
orchestrator or return synthetic data.

```text
Browser component
    -> Next.js route handler
        -> ORCHESTRATOR_URL
            -> EnderCloud orchestrator
```

The proxy adds no authentication. Deploy the dashboard on a trusted operator network and keep the
orchestrator private. `ORCHESTRATOR_URL` is server-side and must never be exposed through a
`NEXT_PUBLIC_` variable.

Upstream requests time out after eight seconds. The proxy preserves the orchestrator's
`x-request-id` response header for diagnosis and returns HTTP 502 when the upstream cannot be
reached.

## Environment variables

Create a local file from the example:

```powershell
Copy-Item .env.example .env.local
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORCHESTRATOR_URL` | `http://localhost:8080` | Server-side orchestrator base URL |
| `DASHBOARD_MOCK_DATA` | Disabled | Serve a deterministic synthetic cluster |

Mock mode accepts `1`, `true`, `yes`, or `on`, ignoring case and surrounding spaces.

The root Compose stack sets `ORCHESTRATOR_URL=http://orchestrator:8080` and disables mock mode.
Published dashboard address and port are Compose-only values documented in
[`docs/ENVIRONMENT.md`](../docs/ENVIRONMENT.md).

## Local development

From `dashboard/`:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env.local
bun run dev
```

The console listens on `http://localhost:3000`.

Run the orchestrator on `http://localhost:8080`, or enable synthetic data in `.env.local`:

```dotenv
DASHBOARD_MOCK_DATA=true
```

The sidebar displays a `Synthetic data` marker while mock mode is active.

## Synthetic cluster

`src/lib/mock-data.ts` builds a fixed cluster on every request. Identifiers stay stable across
refreshes, while ages, deadlines, queue waits, and monitoring timestamps move with the current
time.

The data covers hub and minigame groups, a disabled group, healthy and degraded hosts, warm and
reserved instances, running and stalled sessions, populated queues, startup retry states,
monitoring series, and operational incidents.

Maintenance and retry actions return a successful response in synthetic mode but do not persist
between requests. The next request rebuilds the fixed cluster.

Use mock mode for component work, screenshots, demos, and Playwright. Use a real orchestrator for
transaction, deadline, and action behavior.

## Time display

`src/lib/clock.ts` owns one server-relative clock:

- It anchors to the orchestrator's `generatedAt` timestamp instead of trusting the browser clock.
- It advances once per second without issuing a request every second.
- It re-anchors when a newer response arrives and ignores responses that would move time backward.
- The API layer synchronizes the clock before React renders the response.
- `Elapsed`, `RelativeTime`, and `Countdown` subscribe independently, so only live time cells
  rerender each second.

Timeline counters continue while query auto-refresh is paused. The client never invents a business
deadline from entity state. It renders `activeDeadline` from the versioned instance and session
contracts.

Rendered `<time>` elements retain the exact UTC timestamp in `dateTime` and their hover title.

## UI structure

| Path | Role |
| --- | --- |
| `src/app/` | Next.js pages, layout, global styles, and server route handlers |
| `src/components/` | Operational components shared across pages |
| `src/components/ui/` | shadcn/ui primitives managed by the CLI |
| `src/lib/api.ts` | Browser-facing data functions and clock synchronization |
| `src/lib/contracts.ts` | Dashboard view contracts |
| `src/lib/orchestrator-proxy.ts` | Server-side upstream boundary and timeout |
| `src/lib/mock-data.ts` | Deterministic synthetic cluster |
| `test/` | Bun unit and route tests |
| `e2e/` | Playwright browser suite |

The UI was initialized from shadcn preset `b0`, which uses the `base-nova` style, a neutral base
color, Inter, and Lucide icons. Inspect the preset with:

```powershell
npx shadcn@latest preset decode b0
```

Add or update primitives through the CLI when possible:

```powershell
npx shadcn@latest add <component>
```

`src/app/globals.css` adds semantic success, warning, and information colors for both themes.
`src/lib/status.ts` maps contract states to visual tones. Light and dark themes follow the system
preference by default and can be changed from the header.

## Validation

Run static checks, unit tests, and a production build:

```powershell
bun run lint
bun run typecheck
bun test
bun run build
```

Install Chromium once, then run the browser suite:

```powershell
npx playwright install chromium
bun run test:e2e
```

Playwright builds the dashboard and starts it on port 3100 with synthetic data. It runs desktop
Chromium and a mobile viewport.

See [the project test reference](../docs/TEST.md) for the full repository validation sequence.

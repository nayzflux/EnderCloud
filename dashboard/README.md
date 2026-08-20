# EnderCloud Dashboard

Operations console for the EnderCloud cluster. It reads groups, hosts, warm capacity,
matchmaking queues, instances and sessions. The Hosts page can also request a confirmed drain or
reactivation. The application uses Next.js, TanStack Query, React Flow and shadcn/ui.

## Pages

| Route        | What it answers                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| `/`          | Fleet health at a glance: summary tiles, lifecycle distribution, capacity per group, what needs attention |
| `/groups`    | Capacity policy, matchmaking or routing rules, lifecycle timeouts and variants of every group |
| `/groups/[groupId]/variants` | Ordered template layers, effective runtime settings and file summaries for a group |
| `/hosts`     | Agent health, administrative state, resource reservations and confirmed maintenance actions |
| `/instances` | Sortable, filterable table of every managed container, with a detail panel per instance |
| `/sessions`  | Matches formed by the matchmaker, their assigned instance and connection progress |
| `/queues`    | Queue pressure per matchmaking group: parties, wait-time distribution and the queued parties themselves |
| `/topology`  | React Flow map wiring each group's queue and warm pool to its instances and sessions |
| `/monitoring` | Startup readiness and Paper TPS time series, grouped by variant with shared alert thresholds |

Selecting an instance or a session opens the same detail panel wherever it appears. The panel
shows players, commands, events, teams and transfers. Its Lifecycle section orders the completed
steps, measures each duration and shows the one active deadline selected by the orchestrator.

## Elapsed times

A single clock in `src/lib/clock.ts` drives every displayed age and countdown:

- it anchors on the `generatedAt` timestamp from the orchestrator, so a client with an incorrect
  clock still shows server-relative durations;
- it advances on its own once a second, and re-anchors whenever fresher data
  lands. An out-of-order response is ignored rather than letting time run
  backwards;
- `syncClock` is called from the API layer, not from an effect, so the correction
  is applied before React renders the data it came with;
- the `Elapsed`, `RelativeTime` and `Countdown` components in
  `src/components/live-time.tsx` subscribe independently, so only time cells rerender every
  second.

The timeline counters continue while auto-refresh is paused, without issuing a
network request every second. The client never infers a business deadline from
an entity state. It renders `activeDeadline` from the versioned instance and session detail
contracts.

Anything with a fixed instant behind it (`title` and `dateTime` on the rendered
`<time>`) keeps the exact UTC value one hover away.

## UI foundation

The interface is generated from the shadcn CLI using preset `b0`
(`base-nova` style, neutral base colour, Inter, lucide icons). To inspect or
re-apply it:

```bash
npx shadcn@latest preset decode b0
```

Components live in `src/components/ui` and are managed by the CLI. Add more
with `npx shadcn@latest add <component>` rather than hand-writing them. On top
of the neutral preset, `src/app/globals.css` defines `--success`, `--warning`
and `--info` so operational states stay readable in both themes; the mapping
from a contract state to a tone lives in `src/lib/status.ts`.

Light and dark themes both ship, following the system preference by default and
switchable from the header.

## Development

```powershell
Copy-Item .env.example .env.local
bun install --frozen-lockfile
bun run dev
```

The console is served on `http://localhost:3000`. `ORCHESTRATOR_URL` is server-side only. The
browser calls dashboard proxy routes for reads and for the two confirmed host maintenance
actions. Those server routes do not add authentication, so the dashboard and orchestrator still
belong on a private network.

### Synthetic data

Set `DASHBOARD_MOCK_DATA=true` to serve a synthetic cluster instead of proxying
the orchestrator, so the console can be developed and demoed without Docker,
PostgreSQL, Redis or a running orchestrator:

```powershell
"DASHBOARD_MOCK_DATA=true" | Add-Content .env.local
bun run dev
```

The sidebar shows a `Synthetic data` marker whenever the flag is on. The world
is rebuilt from a fixed seed on every request, so identifiers stay stable across
refreshes while ages, deadlines and queue waits keep ticking. It covers four
groups (a hub, two live minigames and a disabled one), healthy and degraded
instances, running and stalled sessions, populated queues, and deterministic
monitoring series with alerts. Host maintenance requests return success in this mode but do not
persist between requests. See `src/lib/mock-data.ts`.

## Validation

```powershell
bun run lint
bun run typecheck
bun test
bun run test:e2e
bun run build
```

`bun test` covers the clock, timeline, topology and variant layout builders, formatting helpers,
monitoring charts and synthetic cluster coherence. The Playwright suite builds the app and
runs it on port 3100 with `DASHBOARD_MOCK_DATA=true`, covering desktop Chromium
and a mobile viewport; browsers are installed with `npx playwright install
chromium`.

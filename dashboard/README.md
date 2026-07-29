# EnderCloud Dashboard

Read-only operations console for the EnderCloud cluster: groups, warm capacity,
matchmaking queues, instances and the sessions running on them. Built with
Next.js, TanStack Query, React Flow and shadcn/ui.

## Pages

| Route        | What it answers                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| `/`          | Fleet health at a glance: summary tiles, lifecycle distribution, capacity per group, what needs attention |
| `/groups`    | Capacity policy, matchmaking or routing rules, lifecycle timeouts and variants of every group |
| `/instances` | Sortable, filterable table of every managed container, with a detail panel per instance |
| `/sessions`  | Matches formed by the matchmaker, their assigned instance and connection progress |
| `/queues`    | Queue pressure per matchmaking group: parties, wait-time distribution and the queued parties themselves |
| `/topology`  | React Flow map wiring each group's queue and warm pool to its instances and sessions |

Selecting an instance or a session anywhere in the console opens the same detail
panel, with its players, commands, events, teams and transfers. Its **Lifecycle**
section is a timeline: the steps in the order they happen, how long each one took,
which step the entity is sitting on right now, and the deadline it is racing
against.

## Elapsed times

Durations used to move only when a packet arrived, so every age jumped five
seconds at a time. A single clock, in `src/lib/clock.ts`, now drives all of them:

- it anchors on the `generatedAt` the orchestrator stamps on every payload, so
  ages are measured against the **orchestrator's** clock — a device whose clock
  is off still shows the right numbers;
- it advances on its own once a second, and re-anchors whenever fresher data
  lands. An out-of-order response is ignored rather than letting time run
  backwards;
- `syncClock` is called from the API layer, not from an effect, so the correction
  is applied before React renders the data it came with;
- the `Elapsed`, `RelativeTime` and `Countdown` components in
  `src/components/live-time.tsx` each subscribe on their own, so a two-hundred
  row table re-renders its time cells every second — not the whole table.

Anything with a fixed instant behind it (`title` and `dateTime` on the rendered
`<time>`) keeps the exact UTC value one hover away.

## UI foundation

The interface is generated from the shadcn CLI using preset `b0`
(`base-nova` style, neutral base colour, Inter, lucide icons). To inspect or
re-apply it:

```bash
npx shadcn@latest preset decode b0
```

Components live in `src/components/ui` and are managed by the CLI — add more
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

The console is served on `http://localhost:3000`. `ORCHESTRATOR_URL` stays a
server-side variable: the browser only ever talks to the dashboard's four
read-only proxy routes.

### Synthetic data

Set `DASHBOARD_MOCK_DATA=true` to serve a synthetic cluster instead of proxying
the orchestrator, so the console can be developed and demoed without Docker,
PostgreSQL, Redis or a running orchestrator:

```powershell
"DASHBOARD_MOCK_DATA=true" | Add-Content .env.local
bun run dev
```

The sidebar shows a **Synthetic data** marker whenever the flag is on. The world
is rebuilt from a fixed seed on every request, so identifiers stay stable across
refreshes while ages, deadlines and queue waits keep ticking. It covers four
groups (a hub, two live minigames and a disabled one), healthy and degraded
instances, running and stalled sessions, and populated queues. See
`src/lib/mock-data.ts`.

## Validation

```powershell
bun run lint
bun run typecheck
bun test
bun run test:e2e
bun run build
```

`bun test` covers the topology layout builder, the formatting helpers and the
coherence of the synthetic cluster. The Playwright suite builds the app and
runs it on port 3100 with `DASHBOARD_MOCK_DATA=true`, covering desktop Chromium
and a mobile viewport; browsers are installed with `npx playwright install
chromium`.

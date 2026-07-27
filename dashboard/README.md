# EnderCloud Dashboard

Console interne en lecture seule pour observer les groupes, la capacité chaude, les files de
matchmaking, les instances et leurs sessions. L'interface utilise Next.js, React Flow,
TanStack Query et shadcn/ui, avec un rafraîchissement automatique toutes les cinq secondes.

## Développement

Copier `.env.example` vers `.env.local`, puis renseigner l'URL HTTP de l'orchestrateur :

```powershell
Copy-Item .env.example .env.local
bun install --frozen-lockfile
bun run dev
```

Le dashboard est disponible sur `http://localhost:3000`. `ORCHESTRATOR_URL` reste une variable
serveur : le navigateur passe uniquement par les quatre routes proxy en lecture du dashboard.

## Validation

```powershell
bun run lint
bun run typecheck
bun test
bun run test:e2e
bun run build
```

Les tests Playwright utilisent une API simulée et couvrent Chromium desktop ainsi qu'un viewport
mobile.

# EnderCloud website

The `web/` application is the public EnderCloud product site and documentation. It is independent from the operational dashboard in `dashboard/` and exposes only the landing page, Fumadocs routes, and the local search endpoint.

## Commands

Install dependencies and run the development server:

```powershell
cd web
bun install --frozen-lockfile
bun run dev
```

Validate a change:

```powershell
bun run lint
bun run typecheck
bun run build
bun run test:e2e
```

Playwright requires Chromium once per machine:

```powershell
bunx playwright install chromium
```

## Configuration

Copy `.env.example` to `.env.local` and set `SITE_URL` to the canonical public HTTPS origin. It is used by metadata, canonical URLs, Open Graph URLs, robots, and the sitemap. Do not deploy the public site with the local default.

Documentation lives in `content/docs`. It is an edited local snapshot of the repository documentation; changes in the root `docs/` directory are not synchronized automatically.

Dashboard screenshots are imported statically from `src/assets/dashboard` so Next.js can optimize their dimensions and placeholders.

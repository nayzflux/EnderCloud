FROM node:24.13.0-bookworm-slim AS builder
COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json bun.lock ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/agent/package.json ./apps/agent/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/runtime/package.json ./packages/runtime/package.json
RUN bun install --frozen-lockfile --filter @endercloud/dashboard
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard
WORKDIR /workspace/apps/dashboard
RUN mkdir -p public && bun run build

FROM node:24.13.0-bookworm-slim AS runner
WORKDIR /workspace
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder --chown=node:node /workspace/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=node:node /workspace/apps/dashboard/public ./apps/dashboard/public
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]

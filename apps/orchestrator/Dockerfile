FROM oven/bun:1.4.2-alpine
WORKDIR /workspace
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/orchestrator/package.json ./apps/orchestrator/package.json
COPY apps/agent/package.json ./apps/agent/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/runtime/package.json ./packages/runtime/package.json
RUN bun install --frozen-lockfile --production --filter @endercloud/orchestrator
COPY packages ./packages
COPY apps/orchestrator ./apps/orchestrator
WORKDIR /workspace/apps/orchestrator
EXPOSE 8080
CMD ["bun", "src/index.ts"]

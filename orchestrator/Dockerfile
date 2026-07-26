FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json drizzle.config.ts ./
COPY migrations ./migrations
COPY src ./src

EXPOSE 8080
CMD ["bun", "src/index.ts"]

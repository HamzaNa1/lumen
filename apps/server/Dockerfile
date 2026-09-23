FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=dependencies /app/bun.lock ./bun.lock
COPY apps/server ./apps/server
COPY packages/contracts ./packages/contracts
COPY packages/database ./packages/database
RUN useradd --system --uid 10001 --create-home lumen && mkdir -p /data /media && chown -R lumen:lumen /app /data /media
USER lumen
VOLUME ["/data", "/media"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e 'fetch("http://127.0.0.1:3210/health/ready").then(r => { if (!r.ok) process.exit(1) })'
CMD ["bun", "apps/server/src/main.ts"]

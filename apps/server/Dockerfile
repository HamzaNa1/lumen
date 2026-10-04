FROM mwader/static-ffmpeg:9.0@sha256:b90574a4e2ae62b763c39c384526689e7eb435da6398f4fb3f6c3f1c6a14ce33 AS ffprobe

FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN bun install --frozen-lockfile --production

# Builds the browser app. Only its compiled output reaches the runtime image.
FROM oven/bun:1.4.2 AS web
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/app/package.json packages/app/package.json
RUN bun install --frozen-lockfile
COPY apps/web apps/web
COPY packages/contracts packages/contracts
COPY packages/client packages/client
COPY packages/ui packages/ui
COPY packages/app packages/app
# The build reads the server's version, which is the version the web app reports.
COPY apps/server/package.json apps/server/package.json
RUN bun run --cwd apps/web build

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production \
    LUMEN_HOST=0.0.0.0 \
    LUMEN_DATA_DIR=/data \
    LUMEN_DATABASE_PATH=/data/lumen.sqlite
RUN groupadd --system --gid 10001 lumen \
    && useradd --system --uid 10001 --gid 10001 --create-home lumen \
    && install -d -o 10001 -g 10001 /app /data /media
COPY --from=ffprobe /ffprobe /usr/local/bin/ffprobe
COPY --chown=10001:10001 --from=dependencies /app/node_modules ./node_modules
COPY --chown=10001:10001 --from=dependencies /app/package.json ./package.json
COPY --chown=10001:10001 --from=dependencies /app/bun.lock ./bun.lock
COPY --chown=10001:10001 apps/server ./apps/server
COPY --chown=10001:10001 packages/contracts ./packages/contracts
COPY --chown=10001:10001 packages/database ./packages/database
COPY --chown=10001:10001 --from=web /app/apps/web/dist ./apps/web/dist
COPY --chown=10001:10001 --from=dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --chown=10001:10001 --from=dependencies /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --chown=10001:10001 --from=dependencies /app/packages/database/node_modules ./packages/database/node_modules
USER lumen
VOLUME ["/data", "/media"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e 'fetch("http://127.0.0.1:3210/health/ready").then(r => { if (!r.ok) process.exit(1) })'
CMD ["bun", "apps/server/src/main.ts"]

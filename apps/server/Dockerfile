FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json biome.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN bun install --frozen-lockfile --production

# Builds the browser app. Only its compiled output reaches the runtime image.
FROM oven/bun:1.4.4 AS web
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

# The release tree that both the image and the Linux service package run.
FROM scratch AS app
COPY --from=dependencies /app/node_modules /node_modules
COPY --from=dependencies /app/package.json /package.json
COPY --from=dependencies /app/bun.lock /bun.lock
COPY apps/server /apps/server
COPY packages/contracts /packages/contracts
COPY packages/database /packages/database
COPY --from=web /app/apps/web/dist /apps/web/dist
COPY --from=dependencies /app/apps/server/node_modules /apps/server/node_modules
COPY --from=dependencies /app/packages/contracts/node_modules /packages/contracts/node_modules
COPY --from=dependencies /app/packages/database/node_modules /packages/database/node_modules

# Exported as the Linux service package: the release tree, its Bun, and the bin/ entry points.
FROM scratch AS linux-package
COPY --from=app / /
COPY --from=dependencies /usr/local/bin/bun /bin/bun
COPY apps/server/linux/bin /bin

FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production \
    LUMEN_HOST=0.0.0.0 \
    LUMEN_DATA_DIR=/data \
    LUMEN_DATABASE_PATH=/data/lumen.sqlite \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg mesa-va-drivers \
    && if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 lumen \
    && useradd --system --uid 10001 --gid 10001 --create-home lumen \
    && install -d -o 10001 -g 10001 /app /data /media
COPY --chown=10001:10001 --from=app / /app/
USER lumen
VOLUME ["/data", "/media"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e 'fetch("http://127.0.0.1:3210/health/ready").then(r => { if (!r.ok) process.exit(1) })'
CMD ["bun", "apps/server/src/main.ts"]

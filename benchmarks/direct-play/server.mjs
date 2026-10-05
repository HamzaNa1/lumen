import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, file, policy = "throughput"] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { makeHttpHandler } = await load("apps/server/src/http/HttpApp.ts");
const { decodeConfig } = await load("apps/server/src/config/Config.ts");
const { createLogger } = await load("apps/server/src/core/Logger.ts");
const { Effect } = await load("apps/server/node_modules/effect/dist/index.js");
const details = await stat(file);
const config = decodeConfig({});
if (policy === "throughput") {
  Object.assign(config, {
    maxRequestsPerMinute: 100000,
    mediaRequestsPerMinute: 100000,
    mediaPeerRequestsPerMinute: 100000,
    mediaBurst: 10000,
  });
}
let cpu = process.cpuUsage();
let peakRss = 0;
let requests = 0;
let aborted = 0;
let sample;
const handler = makeHttpHandler(
  {
    playback: {
      authorizeGrant: () =>
        Effect.succeed({
          absolutePath: file,
          size: details.size,
          modifiedAtMs: details.mtimeMs,
          mimeType: "application/octet-stream",
          sessionId: "benchmark-session",
          userId: "benchmark-user",
        }),
    },
  },
  config,
  createLogger({ level: "info", format: "json", destination: { write: () => {} } }),
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, transport) {
    const path = new URL(request.url).pathname;
    if (path === "/benchmark/begin") {
      clearInterval(sample);
      cpu = process.cpuUsage();
      peakRss = process.memoryUsage().rss;
      sample = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 10);
      return Response.json({ ok: true });
    }
    if (path === "/benchmark/stats") {
      clearInterval(sample);
      const usage = process.cpuUsage(cpu);
      return Response.json({
        cpuMs: (usage.user + usage.system) / 1000,
        peakRssMiB: peakRss / 1048576,
        requests,
        aborted,
      });
    }
    if (path === "/benchmark/quit") {
      setTimeout(() => {
        server.stop(true);
        process.exit(0);
      }, 20);
      return Response.json({ ok: true });
    }
    if (path.startsWith("/api/v1/media/")) {
      requests++;
      request.signal.addEventListener(
        "abort",
        () => {
          aborted++;
        },
        { once: true },
      );
    }
    return handler(request, {
      peerAddress: transport.requestIP(request)?.address ?? null,
      disableIdleTimeout: () => transport.timeout(request, 0),
    });
  },
});
console.log(JSON.stringify({ origin: server.url.origin }));

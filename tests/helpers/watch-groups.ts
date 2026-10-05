import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../apps/server/src/Runtime";
import {
  bearerCredentials,
  ServerApi,
  type WatchConnection,
  WatchGroupClient,
} from "../../packages/client/src/index.ts";
import { seedPlaybackFixture } from "./playback";
import { eventually } from "./eventually";

export const watchFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-watch-test-"));
  const databasePath = join(root, "server.sqlite");
  const seeded = await seedPlaybackFixture(root, databasePath);
  const running = await startServer({
    databasePath,
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
  });
  const clients: WatchGroupClient[] = [];
  const login = async (username = "admin") => {
    let accessToken: string | null = null;
    const server = new ServerApi({
      origin: running.server.url.toString(),
      credentials: bearerCredentials(() => accessToken),
    });
    await server.identity();
    const session = await server.tokenLogin(
      {
        username,
        password: "correct horse battery staple",
      },
      { deviceId: crypto.randomUUID(), deviceName: "Test", platform: "desktop" },
    );
    accessToken = session.accessToken;
    return Object.assign(server, {
      currentSession: session,
      watchAuthentication: () => ({ token: session.accessToken }),
    });
  };
  const connect = async (server: WatchConnection) => {
    const client = new WatchGroupClient(server, () => undefined);
    clients.push(client);
    client.connect();
    await eventually(() => client.status.connection === "connected");
    return client;
  };
  return {
    ...seeded,
    running,
    login,
    connect,
    async close() {
      for (const client of clients) client.close();
      await running.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
};

export const watchProxy = (origin: URL) => {
  type Connection = { upstream: WebSocket; ready: Promise<void> };
  const sockets = new Set<import("bun").ServerWebSocket<Connection>>();
  let dropJoin = false;
  let busyJoin = false;
  let retryAfterMs = 20;
  let stopStalled = false;
  const pendingStops: { socket: import("bun").ServerWebSocket<Connection>; raw: string }[] = [];
  const server = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        const incoming = new URL(request.url);
        return fetch(new URL(incoming.pathname + incoming.search, origin), request);
      }
      const url = new URL("/api/v1/watch-groups", origin);
      url.protocol = "ws:";
      const upstream = new WebSocket(url);
      const ready = new Promise<void>((resolve) =>
        upstream.addEventListener("open", () => resolve(), { once: true }),
      );
      if (server.upgrade(request, { data: { upstream, ready } })) return;
      upstream.close();
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.data.upstream.onmessage = (event) => socket.send(String(event.data));
        socket.data.upstream.onclose = () => socket.close();
      },
      async message(socket, message) {
        const raw = String(message);
        const request = JSON.parse(raw) as { requestId?: string; action?: { type?: string } };
        if (stopStalled && request.action?.type === "stop") {
          pendingStops.push({ socket, raw });
          return;
        }
        if (busyJoin && request.action?.type === "join") {
          busyJoin = false;
          socket.send(
            JSON.stringify({
              type: "reply",
              requestId: request.requestId,
              error: "Temporarily busy",
              retryAfterMs,
            }),
          );
          return;
        }
        if (dropJoin && request.action?.type === "join") {
          dropJoin = false;
          socket.close();
          return;
        }
        await socket.data.ready;
        if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(raw);
      },
      close(socket) {
        sockets.delete(socket);
        socket.data.upstream.close();
      },
    },
  });
  return {
    origin: server.url.toString(),
    stallStop() {
      stopStalled = true;
    },
    releaseStops() {
      stopStalled = false;
      for (const { socket, raw } of pendingStops.splice(0)) {
        if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(raw);
      }
    },
    overloadRejoin(delayMs = 20) {
      retryAfterMs = delayMs;
      busyJoin = true;
      for (const socket of sockets) socket.close();
    },
    interruptRejoin() {
      dropJoin = true;
      for (const socket of sockets) socket.close();
    },
    async close() {
      await server.stop(true);
    },
  };
};

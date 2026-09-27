import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../apps/server/src/Runtime";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { WatchGroupClient } from "../../apps/desktop/src/main/watch-groups/WatchGroupClient";
import { seedPlaybackFixture } from "./playback";

export const eventually = async (ready: () => boolean, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
};

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
    const server = new ServerClient({ origin: running.server.url.toString() });
    await server.login(
      {
        origin: running.server.url.toString(),
        serverLabel: "Test",
        username,
        password: "correct horse battery staple",
      },
      crypto.randomUUID(),
    );
    return server;
  };
  const connect = async (server: ServerClient) => {
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
  const server = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
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
        if (busyJoin && request.action?.type === "join") {
          busyJoin = false;
          socket.send(
            JSON.stringify({
              type: "reply",
              requestId: request.requestId,
              error: "Temporarily busy",
              retryAfterMs: 20,
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
    overloadRejoin() {
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

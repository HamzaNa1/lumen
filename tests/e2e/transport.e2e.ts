import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { NetworkProxy } from "./support/proxy";
import { expect, repository, test } from "./support/server";

test("network proxy closes both peers after interrupted upgrades and relay socket failures", async () => {
  const upstream = createServer();
  const sockets = new Set<Duplex>();
  upstream.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("end", () => socket.end());
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Upstream did not listen");
  const proxy = await new NetworkProxy(`http://127.0.0.1:${address.port}`).start();
  const clients = new Set<Socket>();
  try {
    for (const fault of ["pending upgrade", "client reset", "upstream reset"] as const) {
      await test.step(fault, async () => {
        const client = createConnection(Number(new URL(proxy.origin).port), "127.0.0.1");
        clients.add(client);
        client.on("error", () => client.destroy());
        await once(client, "connect");
        const accepted = once(upstream, "upgrade");
        client.write(
          "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        const [, remote] = (await accepted) as [unknown, Socket];
        let clientClosed = false;
        let remoteClosed = false;
        client.once("close", () => {
          clientClosed = true;
        });
        remote.once("close", () => {
          remoteClosed = true;
        });
        if (fault === "pending upgrade") client.end();
        else {
          const received = once(client, "data");
          remote.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
          if (fault === "client reset") {
            const chunk = Buffer.alloc(65536);
            const send = () => {
              if (remote.destroyed) return;
              if (remote.write(chunk)) setImmediate(send);
              else remote.once("drain", send);
            };
            send();
          }
          await received;
          if (fault === "client reset") client.resetAndDestroy();
          else remote.resetAndDestroy();
        }
        await expect
          .poll(() => ({ clientClosed, remoteClosed }), { timeout: 5000 })
          .toEqual({ clientClosed: true, remoteClosed: true });
      });
    }
  } finally {
    for (const client of clients) client.destroy();
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("HTTP transport and desktop bridge preserve framing, reject redirects, propagate overload and cancel failed streams", async ({
  playwright: _playwright,
}) => {
  const child = spawn("bun", [join(repository, "tests/e2e/support/transport-entry.ts")], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: process.env,
  });
  const errors: string[] = [];
  child.stderr?.on("data", (data) => errors.push(String(data)));
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
    expect(ready.bindRejected).toBe(true);
    const get = (path: string) =>
      fetch(new URL(path, ready.origin), { signal: AbortSignal.timeout(5000) });
    const echo = await fetch(new URL("/echo", ready.origin), {
      method: "POST",
      body: "UTF8: café",
    });
    expect(echo.status).toBe(201);
    expect(echo.headers.get("x-peer")).toBe("127.0.0.1");
    expect(echo.headers.getSetCookie()).toEqual(["first=1; HttpOnly", "second=2; HttpOnly"]);
    expect(echo.headers.get("transfer-encoding")).toBeNull();
    expect(echo.headers.get("content-length")).toBe(String(Buffer.byteLength("UTF8: café")));
    expect(await echo.text()).toBe("UTF8: café");
    expect((await get("/before")).status).toBe(500);
    expect((await get("/unhandled")).status).toBe(426);
    const media = (range?: string) =>
      fetch(ready.bridge, { headers: range ? { range } : {}, signal: AbortSignal.timeout(5000) });
    expect((await media("bytes=1-")).status).toBe(502);
    const limited = await media("bytes=2-");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3");
    expect(await limited.text()).toBe("limited");
    expect((await media("bytes=3-")).status).toBe(502);
    const truncated = await media();
    await get("/break");
    await expect(truncated.arrayBuffer()).rejects.toThrow();
    await expect.poll(async () => (await (await get("/status")).json()).transfers).toBe(0);
    const pending = await media();
    const body = pending.body?.getReader();
    expect(await body?.read()).toMatchObject({ done: false });
    await get("/revoke");
    await expect
      .poll(async () => await (await get("/status")).json())
      .toMatchObject({ aborted: true, cancelled: true, redirects: 0, transfers: 0 });
    expect((await media()).status).toBe(404);
    const status = await (await get("/status")).json();
    expect(status.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "bridge_transfer",
        fields: expect.objectContaining({
          status: 429,
          bytesForwarded: 7,
          termination: "complete",
        }),
      }),
    );
    expect(JSON.stringify(status)).not.toContain("boundary-grant");
  } finally {
    const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) });
    child.kill("SIGTERM");
    const [code] = await exited;
    expect(code, errors.join("")).toBe(0);
  }
});

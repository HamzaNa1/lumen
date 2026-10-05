import { describe, expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaybackDiagnostics } from "../../packages/client/src/playback/PlaybackDiagnostics";
import { PlaybackBridge } from "../../apps/desktop/src/main/player/PlaybackBridge";
import type { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { createLogger } from "../../apps/server/src/core/Logger";
import { makeHttpHandler, type HttpServices } from "../../apps/server/src/http/HttpApp";
import { serveFile } from "../../apps/server/src/http/ServeFile";

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

const fixture = async (respond: (request: IncomingMessage, response: ServerResponse) => void) => {
  const upstream = createServer(respond);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("No upstream port");
  const bridge = new PlaybackBridge();
  await bridge.listen();
  const diagnostics = new PlaybackDiagnostics();
  const registered = bridge.register({
    connectionId: "connection",
    serverClient: { serverOrigin: `http://127.0.0.1:${address.port}` } as ServerClient,
    streamPath: "/private-media-path",
    bearer: "private-grant",
    active: () => true,
    diagnostics,
  });
  const close = async () => {
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  return { ...registered, bridge, diagnostics, close };
};

const open = (url: string): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, resolve);
    request.on("error", reject);
    request.end();
  });

describe("real HTTP playback bridge", () => {
  test("forwards byte-exact Bun.file full, bounded, open and suffix ranges and HEAD/conditional responses", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bridge-range-"));
    const path = join(workspace, "media.bin");
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    await writeFile(path, bytes);
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        serveFile({
          request,
          path,
          size: bytes.length,
          modifiedAtMs: 1000,
          mimeType: "application/octet-stream",
        }),
    });
    const bridge = new PlaybackBridge();
    await bridge.listen();
    const { url } = bridge.register({
      connectionId: "id",
      serverClient: { serverOrigin: upstream.url.origin } as ServerClient,
      streamPath: "/media",
      bearer: "secret",
      active: () => true,
    });
    try {
      for (const [range, start, end] of [
        [null, 0, 4096],
        ["bytes=2-5", 2, 6],
        ["bytes=4000-", 4000, 4096],
        ["bytes=-10", 4086, 4096],
      ] as const) {
        const response = await fetch(url, { headers: range === null ? {} : { range } });
        expect(response.status).toBe(range === null ? 200 : 206);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end));
      }
      const head = await fetch(url, { method: "HEAD" });
      expect(head.headers.get("content-length")).toBe("4096");
      expect(await head.text()).toBe("");
      const etag = head.headers.get("etag") ?? "";
      const conditional = await fetch(url, { headers: { "if-none-match": etag } });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      const unsatisfiable = await fetch(url, { headers: { range: "bytes=4096-" } });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe("bytes */4096");
    } finally {
      await bridge.close();
      await upstream.stop(true);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("preserves 429 Retry-After, correlates IDs, and rejects redirects without following them", async () => {
    let calls = 0;
    const setup = await fixture((request, response) => {
      calls += 1;
      expect(request.headers.authorization).toBe("Bearer private-grant");
      expect(request.headers["x-request-id"]).toMatch(/^[\da-f-]{36}$/u);
      if (request.headers.range === "bytes=1-")
        response.writeHead(302, { location: "/credential-leak" }).end();
      else
        response
          .writeHead(429, { "retry-after": "3", "x-request-id": request.headers["x-request-id"] })
          .end("limited");
    });
    try {
      const response = await fetch(setup.url);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("3");
      expect(await response.text()).toBe("limited");
      expect((await fetch(setup.url, { headers: { range: "bytes=1-" } })).status).toBe(502);
      expect(calls).toBe(2);
      await waitFor(() => setup.bridge.activeTransferCount === 0);
      const events = setup.diagnostics.snapshot();
      expect(events.find((event) => event.kind === "bridge_transfer")?.fields).toMatchObject({
        status: 429,
        bytesForwarded: 7,
        termination: "complete",
      });
      expect(JSON.stringify(events)).not.toContain("private-");
      expect(events[1]?.fields.serverRequestId).toBe(events[0]?.fields.requestId);
    } finally {
      await setup.close();
    }
  });

  for (const action of ["disconnect", "revoke", "shutdown"] as const) {
    for (const backpressure of [false, true]) {
      test(`${action} cancels an in-flight ${backpressure ? "backpressured" : "stalled read"} transfer`, async () => {
        let upstreamClosed = false;
        let writes = 0;
        const setup = await fixture((_request, response) => {
          response.on("close", () => {
            upstreamClosed = true;
          });
          response.writeHead(200);
          response.write("a");
          if (backpressure) {
            const chunk = new Uint8Array(64 * 1024);
            const pump = () => {
              while (!response.destroyed && writes < 100_000) {
                writes += 1;
                if (!response.write(chunk)) {
                  response.once("drain", pump);
                  return;
                }
              }
            };
            pump();
          }
        });
        let downstream: IncomingMessage | undefined;
        try {
          downstream = await open(setup.url);
          downstream.on("error", () => undefined);
          downstream.pause();
          if (backpressure) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(writes).toBeLessThan(1024);
          }
          if (action === "disconnect") downstream.destroy();
          else if (action === "revoke") setup.bridge.revoke(setup.capability);
          else await setup.bridge.close();
          await waitFor(() => upstreamClosed && setup.bridge.activeTransferCount === 0);
          expect(setup.diagnostics.snapshot().at(-1)?.fields.termination).toBe("cancel");
          if (action === "revoke") expect((await fetch(setup.url)).status).toBe(404);
        } finally {
          downstream?.destroy();
          await setup.close();
        }
      });
    }
  }

  test("preheader errors return 502 and postheader truncation fails instead of ending successfully", async () => {
    const setup = await fixture((request, response) => {
      if (request.headers.range === "bytes=0-") {
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-length": "100" });
      response.write("short");
      setTimeout(() => response.destroy(), 20);
    });
    try {
      expect((await fetch(setup.url, { headers: { range: "bytes=0-" } })).status).toBe(502);
      const response = await fetch(setup.url);
      await expect(response.arrayBuffer()).rejects.toBeDefined();
      await waitFor(() => setup.bridge.activeTransferCount === 0);
      expect(setup.diagnostics.snapshot().at(-1)?.fields).toMatchObject({
        termination: "upstream_failure",
        expectedBytes: 100,
        bytesForwarded: 5,
      });
    } finally {
      await setup.close();
    }
  });
});

test("Bun.file survives a downstream pause longer than the server's default idle timeout", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bridge-pause-"));
  const path = join(workspace, "media.bin");
  const size = 32 * 1024 * 1024;
  await writeFile(path, new Uint8Array(size));
  const handler = makeHttpHandler(
    {
      playback: {
        authorizeGrant: () =>
          Effect.succeed({
            absolutePath: path,
            size,
            modifiedAtMs: 0,
            mimeType: "application/octet-stream",
            sessionId: "session",
            userId: "user",
          }),
      },
    } as unknown as HttpServices,
    decodeConfig({}),
    createLogger({ level: "error", destination: { write: () => undefined } }),
  );
  let exemptions = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) =>
      handler(request, {
        peerAddress: server.requestIP(request)?.address ?? null,
        disableIdleTimeout: () => {
          exemptions += 1;
          server.timeout(request, 0);
        },
      }),
  });
  // Electron's main process runs Node, whose HTTP idle behavior differs from Bun's shim.
  const source = await readFile(
    join(import.meta.dir, "../../apps/desktop/src/main/player/PlaybackBridge.ts"),
    "utf8",
  );
  await writeFile(
    join(workspace, "bridge.mjs"),
    new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(source),
  );
  await writeFile(
    join(workspace, "run.mjs"),
    `
    import { PlaybackBridge } from "./bridge.mjs";
    const bridge = new PlaybackBridge();
    await bridge.listen();
    const { url } = bridge.register({ connectionId: "id", serverClient: { serverOrigin: ${JSON.stringify(upstream.url.origin)} },
      streamPath: "/api/v1/media/track", bearer: "secret", active: () => true });
    process.stdout.write(JSON.stringify(url) + "\\n");
    process.stdin.once("data", async () => { await bridge.close(); process.exit(0); });
  `,
  );
  const child = Bun.spawn(["node", join(workspace, "run.mjs")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = child.stdout.getReader();
  let startupDeadline: ReturnType<typeof setTimeout> | undefined;
  let downstream: IncomingMessage | undefined;
  try {
    let url: string;
    try {
      const listening = async (): Promise<string> => {
        let text = "";
        while (!text.includes("\n")) {
          const chunk = await output.read();
          if (chunk.done) throw new Error("Native bridge exited before listening");
          text += new TextDecoder().decode(chunk.value);
          if (text.length > 1024) throw new Error("Invalid native bridge readiness message");
        }
        return JSON.parse(text);
      };
      url = await Promise.race([
        listening(),
        new Promise<never>((_, reject) => {
          startupDeadline = setTimeout(
            () => reject(new Error("Native Node bridge did not start")),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(startupDeadline);
      output.releaseLock();
    }

    expect((await fetch(new URL("/health/live", upstream.url))).status).toBe(200);
    expect((await fetch(new URL("/api/v1/media/track/", upstream.url))).status).toBe(404);
    expect(exemptions).toBe(0);
    downstream = await open(url);
    expect(exemptions).toBe(1);
    downstream.on("error", () => undefined);
    downstream.pause();
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    let read = 0;
    const ended = new Promise<void>((resolve, reject) => {
      downstream?.on("data", (chunk: Uint8Array) => {
        read += chunk.length;
      });
      downstream?.on("end", resolve);
      downstream?.on("error", reject);
      if (downstream?.destroyed) reject(new Error("Transfer closed while paused"));
    });
    downstream.resume();
    await ended;
    expect(read).toBe(size);
  } finally {
    downstream?.destroy();
    child.stdin.write("close\n");
    child.stdin.end();
    const forcedExit = setTimeout(() => child.kill(), 1000);
    try {
      await child.exited;
    } finally {
      clearTimeout(forcedExit);
    }
    await upstream.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
}, 20_000);

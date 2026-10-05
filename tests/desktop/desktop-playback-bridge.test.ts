import { describe, expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { PlaybackDiagnostics } from "../../packages/client/src/playback/PlaybackDiagnostics";
import { PlaybackBridge } from "../../apps/desktop/src/main/player/PlaybackBridge";
import type { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";

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

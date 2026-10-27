import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerClient } from "../../../apps/desktop/src/main/api/ServerClient";
import { PlaybackBridge } from "../../../apps/desktop/src/main/player/PlaybackBridge";
import { serveHttp } from "../../../apps/server/src/http/HttpServer";
import { PlaybackDiagnostics } from "../../../packages/client/src/playback/PlaybackDiagnostics";

let aborted = false;
let cancelled = false;
let breakBody = () => {};
let redirects = 0;
const server = await serveHttp({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request, context) => {
    const path = new URL(request.url).pathname;
    if (path === "/before") throw new Error("Private transport failure");
    if (path === "/break") {
      breakBody();
      return new Response("broken");
    }
    if (path === "/status")
      return Response.json({
        aborted,
        cancelled,
        redirects,
        transfers: bridge.activeTransferCount,
        diagnostics: diagnostics.snapshot(),
      });
    if (path === "/revoke") {
      bridge.revoke(media.capability);
      return new Response("revoked");
    }
    if (path === "/redirect-target") {
      redirects++;
      return new Response("Never send the grant here");
    }
    if (path === "/echo") {
      const body = await request.text();
      const headers = new Headers({
        "content-length": String(Buffer.byteLength(body)),
        "x-peer": context.peerAddress ?? "",
      });
      headers.append("set-cookie", "first=1; HttpOnly");
      headers.append("set-cookie", "second=2; HttpOnly");
      return new Response(body, { status: 201, headers });
    }
    if (path !== "/asset") return undefined;
    if (request.headers.get("authorization") !== "Bearer boundary-grant")
      return new Response(null, { status: 401 });
    const range = request.headers.get("range");
    if (range === "bytes=1-")
      return new Response(null, { status: 302, headers: { location: "/redirect-target" } });
    if (range === "bytes=2-")
      return new Response("limited", {
        status: 429,
        headers: { "retry-after": "3", "x-request-id": request.headers.get("x-request-id") ?? "" },
      });
    if (range === "bytes=3-")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Unreadable"));
          },
        }),
      );
    request.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("short"));
          breakBody = () => controller.error(new Error("Truncated"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": "100" } },
    );
  },
});
const bridge = new PlaybackBridge();
await bridge.listen();
const diagnostics = new PlaybackDiagnostics();
const media = bridge.register({
  connectionId: "transport",
  serverClient: new ServerClient({ origin: server.url.origin }),
  streamPath: "/asset",
  bearer: "boundary-grant",
  active: () => true,
  diagnostics,
});
let bindRejected = false;
try {
  await serveHttp({
    hostname: "127.0.0.1",
    port: server.port,
    fetch: () => new Response("Wrong listener"),
  });
} catch {
  bindRejected = true;
}
process.send?.({ origin: server.url.toString(), bridge: media.url, bindRejected });
process.once("SIGTERM", async () => {
  await bridge.close();
  await server.stop(true);
  if (process.env.LUMEN_COVERAGE_DIR)
    writeFileSync(
      join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
      JSON.stringify(
        (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__ ?? {},
      ),
    );
  process.exit(0);
});

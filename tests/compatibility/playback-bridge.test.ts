import { expect, test } from "bun:test";
import {
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaybackBridge } from "../../apps/desktop/src/main/player/PlaybackBridge";
import type { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { createLogger } from "../../apps/server/src/core/Logger";
import { makeHttpHandler, type HttpServices } from "../../apps/server/src/http/HttpApp";
import { serveFile } from "../../apps/server/src/http/ServeFile";

const open = (url: string): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, resolve);
    request.on("error", reject);
    request.end();
  });


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
        preserveIdleTimeout: true,
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

test("authorized media survives a downstream pause longer than the server's default idle timeout", async () => {
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

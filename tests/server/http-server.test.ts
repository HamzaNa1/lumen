import { expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { serveHttp } from "../../apps/server/src/http/HttpServer";
import { eventually } from "../helpers/eventually";

test("HTTP transport preserves request bodies, peer identity, lengths and separate cookies", async () => {
  const server = await serveHttp({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, context) => {
      expect(context.peerAddress).toBe("127.0.0.1");
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/echo");
      const body = await request.text();
      const headers = new Headers({ "content-length": String(Buffer.byteLength(body)) });
      headers.append("set-cookie", "first=1; HttpOnly");
      headers.append("set-cookie", "second=2; HttpOnly");
      return new Response(body, { status: 201, headers });
    },
  });
  try {
    const response = await fetch(new URL("/echo", server.url), { method: "POST", body: "hello" });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual(["first=1; HttpOnly", "second=2; HttpOnly"]);
    expect(await response.text()).toBe("hello");
  } finally {
    await server.stop(true);
  }
});

test("disconnecting a streaming client aborts its request and cancels the response body", async () => {
  let aborted = false;
  let cancelled = false;
  const server = await serveHttp({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array([1])),
          cancel: () => {
            cancelled = true;
          },
        }),
      );
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(server.url, (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      request.on("error", reject);
      request.end();
    });
    await eventually(() => aborted && cancelled);
    expect(aborted).toBe(true);
    expect(cancelled).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("transport failures return 500 before headers and terminate an already-started response", async () => {
  let failBody = (): void => {};
  const server = await serveHttp({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/before") throw new Error("Private failure");
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new Uint8Array([1]));
            failBody = () => controller.error(new Error("Read failed"));
          },
        }),
      );
    },
  });
  try {
    const response = await fetch(new URL("/before", server.url));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(server.url, (response) => {
        response.once("data", failBody);
        response.on("error", () => resolve());
        response.on("end", () => reject(new Error("Truncated body completed successfully")));
      });
      request.on("error", reject);
      request.end();
    });
  } finally {
    await server.stop(true);
  }
});

test("failed binds release their resources without disturbing the listening server", async () => {
  const options = { hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") };
  const server = await serveHttp(options);
  try {
    await expect(serveHttp({ ...options, port: server.port })).rejects.toThrow();
    expect(await (await fetch(server.url)).text()).toBe("ready");
  } finally {
    await server.stop();
  }
});

test("declined upgrades preserve the rejection status and release their unused response body", async () => {
  let cancelled = false;
  const server = await serveHttp({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, context) => {
      expect(context.upgrade(request, { data: null })).toBe(false);
      if (request.headers.get("upgrade") === null) return undefined;
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
        { status: 403 },
      );
    },
  });
  try {
    expect((await fetch(server.url)).status).toBe(426);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        server.url,
        {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
    expect(cancelled).toBe(true);
  } finally {
    await server.stop(true);
  }
});

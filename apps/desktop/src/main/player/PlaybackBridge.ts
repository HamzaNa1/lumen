import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { ServerClient } from "../api/ServerClient";

interface Capability {
  readonly connectionId: string;
  readonly serverClient: ServerClient;
  readonly streamPath: string;
  readonly bearer: string;
  readonly active: () => boolean;
}

const forwardedHeaders = (request: IncomingMessage, bearer: string): Headers => {
  const headers = new Headers({ authorization: `Bearer ${bearer}` });
  for (const name of ["range", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
};

export class PlaybackBridge {
  private readonly server = createServer((request, response) => void this.handle(request, response));
  private readonly capabilities = new Map<string, Capability>();
  private port = 0;

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("Bridge did not bind");
    this.port = address.port;
  }

  register(input: Omit<Capability, "connectionId"> & { readonly connectionId: string }): { readonly url: string; readonly capability: string } {
    const capability = randomBytes(32).toString("base64url");
    this.capabilities.set(capability, input);
    return { url: `http://127.0.0.1:${this.port}/${capability}/file`, capability };
  }

  revoke(capability: string): void {
    this.capabilities.delete(capability);
  }

  async close(): Promise<void> {
    this.capabilities.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const segments = requestUrl.pathname.split("/").filter(Boolean);
    const capability = segments[0];
    if (capability === undefined || segments.length !== 2 || segments[1] !== "file") {
      response.writeHead(404).end();
      return;
    }
    const entry = this.capabilities.get(capability);
    if (entry === undefined || !entry.active() || request.headers.host !== `127.0.0.1:${this.port}`) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const upstream = await fetch(new URL(entry.streamPath, entry.serverClient.serverOrigin), {
        method: request.method,
        headers: forwardedHeaders(request, entry.bearer),
        redirect: "manual",
        signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        response.writeHead(502).end();
        return;
      }
      const headers: Record<string, string> = {};
      const contentType = upstream.headers.get("content-type");
      if (contentType !== null) headers["content-type"] = contentType;
      for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      response.writeHead(upstream.status, headers);
      if (request.method === "HEAD" || upstream.body === null) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!response.write(Buffer.from(chunk.value))) await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      } finally {
        reader.releaseLock();
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  }
}

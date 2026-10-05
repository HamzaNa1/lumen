import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { PlaybackDiagnostics } from "@lumen/client";
import type { ServerClient } from "../api/ServerClient";

interface Capability {
  readonly connectionId: string;
  readonly serverClient: ServerClient;
  readonly streamPath: string;
  readonly bearer: string;
  readonly active: () => boolean;
  readonly diagnostics?: PlaybackDiagnostics;
  readonly sessionId?: string;
}
interface Transfer {
  readonly controller: AbortController;
  readonly response: ServerResponse;
  readonly done: Promise<void>;
}

const forwardedHeaders = (request: IncomingMessage, bearer: string, requestId: string): Headers => {
  const headers = new Headers({ authorization: `Bearer ${bearer}`, "x-request-id": requestId });
  for (const name of [
    "range",
    "if-range",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
  ]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
};

export class PlaybackBridge {
  private readonly server = createServer(
    (request, response) => void this.handle(request, response),
  );
  private readonly capabilities = new Map<string, Capability>();
  private readonly transfers = new Map<string, Set<Transfer>>();
  private port = 0;
  private closing: Promise<void> | null = null;

  get activeTransferCount(): number {
    let count = 0;
    for (const transfers of this.transfers.values()) count += transfers.size;
    return count;
  }

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

  register(input: Capability): { readonly url: string; readonly capability: string } {
    if (this.closing !== null || this.port === 0) throw new Error("Bridge is not listening");
    const capability = randomBytes(32).toString("base64url");
    this.capabilities.set(capability, input);
    return { url: `http://127.0.0.1:${this.port}/${capability}/file`, capability };
  }

  revoke(capability: string): void {
    this.capabilities.delete(capability);
    for (const transfer of this.transfers.get(capability) ?? []) {
      transfer.controller.abort();
      transfer.response.destroy();
    }
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    const pending = [...this.transfers.values()].flatMap((entries) =>
      [...entries].map((entry) => entry.done),
    );
    for (const capability of this.capabilities.keys()) this.revoke(capability);
    this.closing = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            new Promise<void>((resolve) => this.server.close(() => resolve())),
            ...pending,
          ]),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        this.server.closeAllConnections();
      }
    })();
    this.server.closeAllConnections();
    return this.closing;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const segments = new URL(request.url ?? "/", "http://127.0.0.1").pathname
      .split("/")
      .filter(Boolean);
    const capability = segments[0];
    const entry = capability === undefined ? undefined : this.capabilities.get(capability);
    if (
      capability === undefined ||
      segments.length !== 2 ||
      segments[1] !== "file" ||
      entry === undefined ||
      !entry.active() ||
      request.headers.host !== `127.0.0.1:${this.port}`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const controller = new AbortController();
    let settle = (): void => undefined;
    const transfer: Transfer = {
      controller,
      response,
      done: new Promise((resolve) => {
        settle = resolve;
      }),
    };
    const active = this.transfers.get(capability) ?? new Set<Transfer>();
    active.add(transfer);
    this.transfers.set(capability, active);
    const disconnect = (): void => {
      if (!response.writableFinished && response.errored === null) controller.abort();
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const socket = response.socket;
    let downstreamFailed = false;
    const downstreamError = (): void => {
      if (response.errored === null && !controller.signal.aborted) downstreamFailed = true;
    };
    socket?.once("error", downstreamError);
    const started = performance.now();
    const requestId = randomUUID();
    let serverRequestId: string | null = null;
    let headerLatencyMs: number | null = null;
    let firstByteLatencyMs: number | null = null;
    let bytesForwarded = 0;
    let lastProgressAt = started;
    let expectedBytes: number | null = null;
    let status: number | null = null;
    let termination = "upstream_failure";
    let upstreamFailed = false;
    let upstream: Response | undefined;
    entry.diagnostics?.record("bridge_request", {
      requestId,
      sessionId: entry.sessionId ?? null,
      method: request.method ?? "GET",
    });
    try {
      upstream = await fetch(new URL(entry.streamPath, entry.serverClient.serverOrigin), {
        method: request.method,
        headers: forwardedHeaders(request, entry.bearer, requestId),
        redirect: "manual",
        signal: controller.signal,
      });
      status = upstream.status;
      headerLatencyMs = performance.now() - started;
      const id = upstream.headers.get("x-request-id");
      serverRequestId = id !== null && /^[\da-f-]{36}$/iu.test(id) ? id : null;
      entry.diagnostics?.record("bridge_headers", {
        requestId,
        serverRequestId,
        status,
        headerLatencyMs,
      });
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        response.writeHead(502).end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
        "cache-control",
        "retry-after",
        "x-request-id",
        "x-admission-reason",
      ]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const length = upstream.headers.get("content-length");
      expectedBytes = length === null ? null : Number(length);
      response.writeHead(upstream.status, headers);
      if (request.method === "HEAD" || upstream.body === null) {
        response.end();
        termination = "complete";
        return;
      }
      // The transform observes forwarding, not player consumption. It passes each Uint8Array
      // through unchanged; pipeline supplies backpressure and tears down both ends on abort.
      const meter = new Transform({
        transform(chunk: Uint8Array, _encoding, callback) {
          const now = performance.now();
          const first = firstByteLatencyMs === null;
          firstByteLatencyMs ??= now - started;
          bytesForwarded += chunk.byteLength;
          if (first || now - lastProgressAt >= 1000) {
            entry.diagnostics?.record(first ? "bridge_first_byte" : "bridge_progress", {
              requestId,
              serverRequestId,
              firstByteLatencyMs,
              bytesForwarded,
              forwardingDurationMs: now - started,
            });
            lastProgressAt = now;
          }
          callback(null, chunk);
        },
        flush(callback) {
          if (expectedBytes !== null && bytesForwarded !== expectedBytes) {
            upstreamFailed = true;
            callback(new Error("Truncated upstream body"));
          } else callback();
        },
      });
      const source = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>);
      source.once("error", (cause: Error) => {
        if (cause.name !== "AbortError") upstreamFailed = true;
      });
      await pipeline(source, meter, response, { signal: controller.signal });
      termination = "complete";
    } catch {
      termination = upstreamFailed
        ? "upstream_failure"
        : downstreamFailed
          ? "downstream_failure"
          : controller.signal.aborted
            ? "cancel"
            : "upstream_failure";
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
      else response.destroy();
    } finally {
      controller.abort();
      // Unused HEAD/redirect bodies must not keep an upstream connection occupied.
      if (upstream?.body !== null && upstream?.body !== undefined && !upstream.body.locked)
        await upstream.body.cancel().catch(() => undefined);
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      socket?.off("error", downstreamError);
      active.delete(transfer);
      if (active.size === 0) this.transfers.delete(capability);
      entry.diagnostics?.record("bridge_transfer", {
        requestId,
        serverRequestId,
        status,
        headerLatencyMs,
        firstByteLatencyMs,
        bytesForwarded,
        expectedBytes,
        transferDurationMs: performance.now() - started,
        termination,
      });
      settle();
    }
  }
}

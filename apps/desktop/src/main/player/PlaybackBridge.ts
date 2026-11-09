import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { PlaybackDiagnostics } from "@lumen/client";
import { decideRange } from "@lumen/contracts";
import type { MediaFile } from "../media-store/MediaFile";

/** A stream proxied as it is: converted media, which has no bytes worth keeping. */
interface ProxiedCapability {
  readonly connectionId: string;
  readonly serverOrigin: string;
  readonly streamPath: string;
  readonly bearer: string;
  readonly active: () => boolean;
  readonly diagnostics?: PlaybackDiagnostics;
  readonly sessionId?: string;
  readonly onStatus?: (status: number) => void;
}

/** A file served from what this device holds, fetching what it lacks as the player asks. */
interface HeldCapability {
  readonly file: MediaFile;
  readonly active: () => boolean;
  readonly diagnostics?: PlaybackDiagnostics;
  readonly sessionId?: string;
}

type Capability = ProxiedCapability | HeldCapability;
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
    if ("file" in entry) {
      await this.serveHeld(capability, entry, request, response);
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
      upstream = await fetch(new URL(entry.streamPath, entry.serverOrigin), {
        method: request.method,
        headers: forwardedHeaders(request, entry.bearer, requestId),
        redirect: "manual",
        signal: controller.signal,
      });
      status = upstream.status;
      entry.onStatus?.(status);
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

  private track(capability: string, response: ServerResponse) {
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
    return {
      controller,
      finish: () => {
        active.delete(transfer);
        if (active.size === 0) this.transfers.delete(capability);
        settle();
      },
    };
  }

  /**
   * Answers from the held file. The length is known before any byte is, so every response is
   * length-delimited, and the player cannot tell held bytes from ones fetched while it waits.
   */
  private async serveHeld(
    capability: string,
    entry: HeldCapability,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { file } = entry;
    const { sizeBytes, revision, mimeType } = file.spec;
    const { controller, finish } = this.track(capability, response);
    const disconnect = (): void => {
      if (!response.writableFinished) controller.abort();
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const requestId = randomUUID();
    const started = performance.now();
    let bytesForwarded = 0;
    let termination = "complete";
    const ifRange = request.headers["if-range"];
    const rangeHeader =
      request.method === "HEAD" || (typeof ifRange === "string" && ifRange !== revision)
        ? null
        : (request.headers.range ?? null);
    const range = decideRange(rangeHeader, sizeBytes);
    entry.diagnostics?.record("bridge_request", {
      requestId,
      sessionId: entry.sessionId ?? null,
      method: request.method ?? "GET",
    });
    try {
      const common = {
        "accept-ranges": "bytes",
        "content-type": mimeType,
        etag: revision,
        "x-request-id": requestId,
      };
      if (range.kind === "unsatisfiable") {
        response.writeHead(416, { ...common, "content-range": `bytes */${sizeBytes}` }).end();
        return;
      }
      const partial = range.kind === "partial";
      const start = partial ? range.start : 0;
      const end = partial ? range.end + 1 : sizeBytes;
      response.writeHead(partial ? 206 : 200, {
        ...common,
        "content-length": String(end - start),
        ...(partial ? { "content-range": `bytes ${start}-${end - 1}/${sizeBytes}` } : {}),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const source = Readable.from(file.read(start, end, controller.signal), { objectMode: false });
      const meter = new Transform({
        transform(chunk: Uint8Array, _encoding, callback) {
          bytesForwarded += chunk.byteLength;
          callback(null, chunk);
        },
      });
      await pipeline(source, meter, response, { signal: controller.signal });
    } catch {
      termination = controller.signal.aborted ? "cancel" : "upstream_failure";
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
      else response.destroy();
    } finally {
      controller.abort();
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      entry.diagnostics?.record("bridge_transfer", {
        requestId,
        serverRequestId: null,
        status: response.statusCode,
        headerLatencyMs: null,
        firstByteLatencyMs: null,
        bytesForwarded,
        expectedBytes: null,
        transferDurationMs: performance.now() - started,
        termination,
      });
      finish();
    }
  }
}

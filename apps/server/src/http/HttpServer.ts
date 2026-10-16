import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { RequestContext } from "./ClientIdentity";

export interface HttpSocket<Data> {
  readonly data: Data;
  send(message: string): number;
  close(code?: number, reason?: string): void;
}

export interface HttpSocketHandler<Data> {
  readonly maxPayloadLength: number;
  readonly idleTimeout: number;
  readonly backpressureLimit: number;
  readonly closeOnBackpressureLimit: boolean;
  readonly open: (socket: HttpSocket<Data>) => void;
  readonly message: (socket: HttpSocket<Data>, message: string | Buffer) => void;
  readonly close: (socket: HttpSocket<Data>, code: number, reason: string) => void;
}

export interface HttpUpgrade<Data> {
  upgrade(request: Request, options: { readonly data: Data }): boolean;
}

export interface HttpServer {
  readonly url: URL;
  readonly port: number;
  stop(force?: boolean): Promise<void>;
}

interface HttpServerOptions<Data> {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (
    request: Request,
    context: RequestContext & HttpUpgrade<Data>,
  ) => Response | undefined | Promise<Response | undefined>;
  readonly websocket?: HttpSocketHandler<Data>;
}

const webRequest = (incoming: IncomingMessage, origin: URL, signal: AbortSignal): Request => {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const url = new URL(incoming.url ?? "/", `http://${headers.get("host") ?? origin.host}`);
  const method = incoming.method ?? "GET";
  return new Request(url.toString(), {
    method,
    headers,
    signal,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : {
          body: Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
          duplex: "half" as const,
        }),
  });
};

const writeResponse = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
  if (response.body === null) outgoing.end();
  else
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      outgoing,
    );
};

/** Keeps explicit response lengths and per-request timeouts while streaming under backpressure. */
export const serveHttp = async <Data>(options: HttpServerOptions<Data>): Promise<HttpServer> => {
  let origin = new URL(
    `http://${options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname}`,
  );
  const handler = options.websocket;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: handler?.maxPayloadLength ?? 4096,
  });
  const server = createServer((incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    const answer = async (): Promise<void> => {
      const request = webRequest(incoming, origin, abort.signal);
      const response = await options.fetch(request, {
        peerAddress: incoming.socket.remoteAddress ?? null,
        disableIdleTimeout: () => outgoing.setTimeout(0),
        upgrade: () => false,
      });
      await writeResponse(response ?? new Response(null, { status: 426 }), outgoing);
    };
    void answer().catch(() => {
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.statusCode = 500;
        outgoing.end();
      }
    });
  });
  server.setTimeout(10_000, (socket) => socket.destroy());
  server.on("upgrade", (incoming, socket, head) => {
    const abort = new AbortController();
    socket.on("close", () => abort.abort());
    const answer = async (): Promise<void> => {
      const request = webRequest(incoming, origin, abort.signal);
      let upgraded = false;
      const response = await options.fetch(request, {
        peerAddress: incoming.socket.remoteAddress ?? null,
        upgrade: (candidate, { data }) => {
          if (handler === undefined || candidate !== request || upgraded) return false;
          upgraded = true;
          sockets.handleUpgrade(incoming, socket, head, (connection: WebSocket) => {
            const peer: HttpSocket<Data> = {
              data,
              send: (message) => {
                if (connection.readyState !== connection.OPEN) return 0;
                connection.send(message);
                if (
                  handler.closeOnBackpressureLimit &&
                  connection.bufferedAmount > handler.backpressureLimit
                )
                  connection.terminate();
                return Buffer.byteLength(message);
              },
              close: (code, reason) => connection.close(code, reason),
            };
            incoming.socket.setTimeout(handler.idleTimeout * 1000, () => connection.terminate());
            connection.on("message", (message, binary) =>
              handler.message(peer, binary ? Buffer.from(message as Buffer) : message.toString()),
            );
            connection.on("close", (code, reason) => handler.close(peer, code, reason.toString()));
            connection.on("error", () => connection.terminate());
            handler.open(peer);
          });
          return true;
        },
      });
      if (!upgraded) {
        const status = response?.status ?? 426;
        await response?.body?.cancel();
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
    };
    void answer().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((cause) => {
    sockets.close();
    throw cause;
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("HTTP server has no address");
  origin = new URL(`${origin.origin}:${address.port}`);
  return {
    url: origin,
    port: address.port,
    stop: async (force = false) => {
      if (force) {
        for (const socket of sockets.clients) socket.terminate();
        server.closeAllConnections();
      }
      sockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

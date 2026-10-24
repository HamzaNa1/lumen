import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Faults at the network boundary; all unaffected traffic goes to the real server. */
export class NetworkProxy {
  origin = "";
  readonly requests: { method: string; path: string }[] = [];
  intercept: (request: IncomingMessage, response: ServerResponse) => Promise<boolean> = async () =>
    false;
  private readonly sockets = new Set<Socket>();
  private readonly watchSockets = new Set<Duplex>();
  watchAvailable = true;
  private readonly http = createServer((incoming, response) => {
    this.requests.push({ method: incoming.method ?? "GET", path: incoming.url ?? "/" });
    void this.forward(incoming, response).catch((error) => {
      if (!response.headersSent) response.writeHead(502);
      response.end(String(error));
    });
  });
  constructor(readonly upstream: string) {
    this.http.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.http.on("upgrade", (incoming, socket, head) => {
      if (!this.watchAvailable) {
        socket.destroy();
        return;
      }
      this.watchSockets.add(socket);
      socket.on("close", () => this.watchSockets.delete(socket));
      const outbound = request(new URL(incoming.url ?? "/", this.upstream), {
        headers: incoming.headers,
      });
      outbound.on("upgrade", (response, remote, remoteHead) => {
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((lines, value, index) => (index % 2 === 0 ? `${lines}${value}: ` : `${lines}${value}\r\n`), "")}\r\n`,
        );
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        remote.pipe(socket);
        socket.pipe(remote);
        socket.on("close", () => remote.destroy());
        remote.on("error", () => socket.destroy());
      });
      outbound.on("error", () => socket.destroy());
      outbound.end();
    });
  }
  private async forward(incoming: IncomingMessage, response: ServerResponse) {
    if (await this.intercept(incoming, response)) return;
    if (response.destroyed) return;
    const outbound = request(
      new URL(incoming.url ?? "/", this.upstream),
      { method: incoming.method, headers: incoming.headers },
      (remote) => {
        response.writeHead(remote.statusCode ?? 502, remote.headers);
        remote.pipe(response);
      },
    );
    outbound.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on("close", () => outbound.destroy());
    incoming.pipe(outbound);
  }
  async start() {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("Proxy did not listen");
    this.origin = `http://127.0.0.1:${address.port}/`;
    return this;
  }
  disconnectWatch() {
    this.watchAvailable = false;
    for (const socket of this.watchSockets) socket.destroy();
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      this.http.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
export function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

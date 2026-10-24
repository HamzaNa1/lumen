import { createRequire } from "node:module";
import type {
  WebSocket as Socket,
  WebSocketServer,
} from "../../../apps/server/node_modules/@types/ws/index";
import { repository } from "./server";

const require = createRequire(`${repository}/apps/server/package.json`);
const ws = require("ws") as { WebSocket: typeof Socket; WebSocketServer: typeof WebSocketServer };

/** Manipulates delivery of real protocol messages without replacing either endpoint. */
export class WatchProxy {
  origin = "";
  hold = false;
  interruptHello = false;
  readonly pending: (() => void)[] = [];
  private readonly connections = new Set<Socket>();
  private readonly server = new ws.WebSocketServer({ port: 0, host: "127.0.0.1" });
  constructor(upstream: string) {
    this.server.on("connection", (client) => {
      const remote = new ws.WebSocket(
        new URL("/api/v1/watch-groups", upstream.replace(/^http/, "ws")),
      );
      this.connections.add(client);
      client.on("close", () => {
        remote.close();
        this.connections.delete(client);
      });
      client.on("error", () => remote.close());
      remote.on("error", () => client.close());
      remote.on("close", () => client.close());
      const queued: string[] = [];
      remote.on("open", () => {
        for (const data of queued) remote.send(data);
      });
      client.on("message", (data) => {
        const payload = data.toString();
        if (remote.readyState === ws.WebSocket.OPEN) remote.send(payload);
        else queued.push(payload);
      });
      remote.on("message", (data) => {
        const message = data.toString();
        if (this.interruptHello && JSON.parse(message).type === "ready") {
          this.interruptHello = false;
          client.close();
          return;
        }
        const send = () => {
          if (client.readyState === ws.WebSocket.OPEN) client.send(message);
        };
        if (this.hold) this.pending.push(send);
        else send();
      });
    });
  }
  async start() {
    if (!this.server.address())
      await new Promise<void>((resolve) => this.server.once("listening", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Watch proxy did not listen");
    this.origin = `http://127.0.0.1:${address.port}`;
    return this;
  }
  disconnect() {
    for (const socket of this.connections) socket.close();
  }
  release(reverse = false) {
    this.hold = false;
    const sends = this.pending.splice(0);
    if (reverse) sends.reverse();
    for (const send of sends) send();
  }
  async close() {
    this.disconnect();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

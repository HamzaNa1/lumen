import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { MpvProcess } from "./MpvProcess";

const CONNECTION_TIMEOUT_MS = 5_000;
const CONNECTION_RETRY_MS = 50;

export type MpvEvent = { readonly event: string } & Record<string, unknown>;
type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export class MpvIpc extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  async connect(process: MpvProcess): Promise<void> {
    const socketPath = process.socketPath;
    if (socketPath === null) throw process.error ?? new Error("MPV has exited");
    this.socket = await this.connectWithRetry(process, socketPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.consume(chunk));
    this.socket.on("error", () => this.rejectAll(new Error("MPV IPC disconnected")));
    this.socket.on("close", () => this.rejectAll(new Error("MPV IPC closed")));
  }

  command(args: ReadonlyArray<string | number>, timeoutMs = 5_000): Promise<unknown> {
    if (this.socket === null) return Promise.reject(new Error("MPV IPC is not connected"));
    const requestId = this.nextId++;
    const message = `${JSON.stringify({ command: args, request_id: requestId })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("MPV command timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket?.write(message, "utf8");
    });
  }

  observe(id: number, property: string): Promise<unknown> {
    return this.command(["observe_property", id, property]);
  }

  close(): void {
    this.rejectAll(new Error("MPV IPC closed"));
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }

  private connectWithRetry(process: MpvProcess, socketPath: string): Promise<Socket> {
    const deadline = Date.now() + CONNECTION_TIMEOUT_MS;

    const attempt = (): Promise<Socket> => {
      if (process.socketPath === null)
        return Promise.reject(process.error ?? new Error("MPV has exited"));
      return new Promise<Socket>((resolve, reject) => {
        const socket = createConnection(socketPath);
        const cleanup = (): void => {
          socket.removeListener("connect", onConnect);
          socket.removeListener("error", onError);
        };
        const onConnect = (): void => {
          cleanup();
          resolve(socket);
        };
        const onError = (cause: Error): void => {
          cleanup();
          socket.destroy();
          const code = (cause as NodeJS.ErrnoException).code;
          if ((code === "ENOENT" || code === "ECONNREFUSED") && Date.now() < deadline) {
            setTimeout(() => void attempt().then(resolve, reject), CONNECTION_RETRY_MS);
            return;
          }
          reject(cause);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
    };

    return attempt();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) {
      this.close();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.handle(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(line: string): void {
    try {
      const message = JSON.parse(line) as {
        request_id?: number;
        error?: string;
        data?: unknown;
        event?: string;
        [key: string]: unknown;
      };
      if (typeof message.event === "string") {
        const { event, ...rest } = message;
        const payload: MpvEvent = { event, ...rest };
        // Surface async mpv events (start-file, file-loaded, end-file, idle,
        // property-change, ...) so callers can fail fast on load errors instead
        // of polling properties on an unloaded file.
        this.emit(event, payload);
        this.emit("mpv-event", payload);
      }
      if (message.request_id !== undefined) {
        const pending = this.pending.get(message.request_id);
        if (pending === undefined) return;
        this.pending.delete(message.request_id);
        clearTimeout(pending.timer);
        if (message.error !== undefined && message.error !== "success")
          pending.reject(new Error(message.error));
        else pending.resolve(message.data ?? null);
      }
    } catch {
      this.close();
    }
  }

  private rejectAll(cause: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
  }
}

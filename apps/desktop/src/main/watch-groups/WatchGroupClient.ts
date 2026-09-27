import { WatchMessage, type WatchAction, type WatchStatus } from "@lumen/contracts";
import { Schema } from "effect";
import type { ServerClient } from "../api/ServerClient";

export class WatchGroupClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private desiredGroup: { groupId: string; password: string } | null = null;
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private offsetMs = 0;
  private bestRtt = Infinity;
  private lastPong = 0;
  status: WatchStatus = {
    connection: "offline",
    memberId: null,
    groups: [],
    group: null,
    error: null,
  };

  constructor(
    private readonly client: ServerClient,
    private readonly onStatus: (status: WatchStatus) => void,
  ) {}

  get serverNow(): number {
    return Date.now() + this.offsetMs;
  }

  connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.update({ connection: "connecting", error: null });
    const url = new URL("/api/v1/watch-groups", this.client.serverOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(), 7000);
    socket.onopen = () =>
      socket.send(JSON.stringify({ token: this.client.currentSession?.accessToken ?? "" }));
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const message = Schema.decodeUnknownSync(WatchMessage)(JSON.parse(String(event.data)));
        if (message.type === "ready") {
          clearTimeout(timeout);
          this.attempts = 0;
          this.bestRtt = Infinity;
          this.lastPong = Date.now();
          this.update({ connection: "connected", memberId: message.memberId, error: null });
          void this.request({ type: "ping", sentAtMs: Date.now() }).catch(() => socket.close());
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong > 15_000) {
              socket.close();
              return;
            }
            void this.request({ type: "ping", sentAtMs: Date.now() }).catch(() => socket.close());
          }, 5000);
          if (this.desiredGroup !== null) {
            void this.request({ type: "join", ...this.desiredGroup }).catch((cause: unknown) => {
              this.desiredGroup = null;
              this.update({
                group: null,
                error: cause instanceof Error ? cause.message : "Could not rejoin group",
              });
            });
          }
        } else if (message.type === "reply") {
          const pending = this.pending.get(message.requestId);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            if (message.error === null) pending.resolve();
            else pending.reject(new Error(message.error));
          }
        } else if (message.type === "pong") {
          this.lastPong = Date.now();
          const rtt = Date.now() - message.sentAtMs;
          if (rtt >= 0 && rtt < this.bestRtt) {
            this.bestRtt = rtt;
            this.offsetMs = message.serverTimeMs - (message.sentAtMs + rtt / 2);
          }
        } else if (message.type === "groups") this.update({ groups: message.groups });
        else this.update({ group: message.group, error: null });
      } catch {
        socket.close(1002, "Invalid server message");
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      clearTimeout(timeout);
      clearInterval(this.heartbeat);
      if (this.socket !== socket) return;
      this.socket = null;
      this.rejectPending("Watch group disconnected. Try again after reconnecting.");
      this.update({
        connection: "offline",
        groups: [],
        error: this.stopped ? null : "Connection lost. Reconnecting…",
      });
      if (!this.stopped)
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          Math.min(10_000, 500 * 2 ** this.attempts++),
        );
    };
  }

  async action(action: WatchAction): Promise<void> {
    await this.request(action);
    if (action.type === "create" && this.status.group !== null)
      this.desiredGroup = { groupId: this.status.group.id, password: action.password };
    if (action.type === "join")
      this.desiredGroup = { groupId: action.groupId, password: action.password };
    if (action.type === "leave") this.desiredGroup = null;
  }

  close(): void {
    this.stopped = true;
    this.desiredGroup = null;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.rejectPending("Watch groups closed");
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.update({ connection: "offline", group: null, groups: [], error: null });
  }

  private request(action: WatchAction): Promise<void> {
    const socket = this.socket;
    if (this.status.connection !== "connected" || socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Watch groups are not connected"));
    if (this.pending.size >= 16) return Promise.reject(new Error("Watch groups are busy"));
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Watch group request timed out"));
        socket.close();
      }, 10_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ requestId, action }));
    });
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private update(patch: Partial<WatchStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }
}

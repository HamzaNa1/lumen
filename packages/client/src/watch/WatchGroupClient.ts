import {
  initialWatchStatus,
  WatchMessage,
  WATCH_CONNECTION_REPLACED,
  WATCH_HEARTBEAT_INTERVAL_MS,
  type WatchAction,
  type WatchGroup,
  type WatchStatus,
} from "@lumen/contracts";
import { Schema } from "effect";
import { randomId } from "../ids.ts";
import { predictWatchAction, type WatchPrediction } from "./watchPrediction.ts";

/** How the socket's first message proves who is connecting. */
export type WatchAuthentication =
  | { readonly token: string }
  // The browser sent its session cookie with the upgrade request.
  | { readonly session: "cookie" };

export interface WatchConnection {
  /** The server's HTTP origin; the socket opens beside it. */
  readonly serverOrigin: string;
  readonly watchAuthentication: () => WatchAuthentication;
}

// A connection that has been silent this long is treated as lost.
const HEARTBEAT_TIMEOUT_MS = 15_000;

class WatchRequestRejected extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

export class WatchGroupClient {
  private readonly clientId = randomId();
  private socket: WebSocket | null = null;
  private stopped = false;
  private rejoinTimer: ReturnType<typeof setTimeout> | undefined;
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
  private holdsForBuffering = false;
  private takesBuffers = false;
  private displayName: string | null = null;
  /** The viewer's group as the server last described it. */
  private group: WatchGroup | null = null;
  /** What actions the server has yet to answer are expected to do, in the order they were sent. */
  private readonly predictions = new Map<string, WatchPrediction>();
  /** As the server describes it, except that `group` already shows the viewer's own actions. */
  status: WatchStatus = initialWatchStatus();

  constructor(
    private readonly connection: WatchConnection,
    private readonly onStatus: (status: WatchStatus) => void,
    /**
     * Whether whoever drives this client answers a group that holds for its members to buffer,
     * with a `ready` action. A group does not wait for a client that would never answer.
     */
    private readonly readiness = false,
  ) {}

  /** Whether the server holds a playing group for a member that says it ran out of media. */
  get waitsForBuffering(): boolean {
    return this.holdsForBuffering;
  }

  /** Whether the server passes on how each member's player is buffered. */
  get sharesBuffers(): boolean {
    return this.takesBuffers;
  }

  get serverNow(): number {
    return Date.now() + this.offsetMs;
  }

  connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.update({ connection: "connecting", error: null });
    const url = new URL("/api/v1/watch-groups", this.connection.serverOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(), 7000);
    let resumeGroupId: string | undefined;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      resumeGroupId = this.desiredGroup?.groupId;
      socket.send(
        JSON.stringify({
          ...this.connection.watchAuthentication(),
          ...(this.readiness ? { readiness: true } : {}),
          buffers: true,
          clientId: this.clientId,
          ...(resumeGroupId === undefined ? {} : { resumeGroupId }),
        }),
      );
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const message = Schema.decodeUnknownSync(WatchMessage)(JSON.parse(String(event.data)));
        if (message.type === "ready") {
          clearTimeout(timeout);
          this.attempts = 0;
          this.bestRtt = Infinity;
          this.lastPong = Date.now();
          this.holdsForBuffering = message.holdsForBuffering === true;
          this.takesBuffers = message.sharesBuffers === true;
          this.displayName = message.displayName ?? null;
          this.update({
            connection: "connected",
            memberId: message.memberId,
            group: null,
            error: null,
          });
          void this.request({ type: "ping", sentAtMs: Date.now() }).catch(() => socket.close());
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT_MS) {
              socket.close();
              return;
            }
            void this.request({ type: "ping", sentAtMs: Date.now() }).catch(() => socket.close());
          }, WATCH_HEARTBEAT_INTERVAL_MS);
          // A leave can arrive while authentication is in flight, after resume intent was
          // sent. Withdraw any transferred membership before recovering the current intent.
          if (resumeGroupId !== undefined && this.desiredGroup?.groupId !== resumeGroupId)
            void this.request({ type: "leave" })
              .then(() => this.rejoin())
              .catch(() => socket.close());
          else void this.rejoin();
        } else if (message.type === "reply") {
          const pending = this.pending.get(message.requestId);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            this.settle(message.requestId);
            if (message.error === null) pending.resolve();
            else
              pending.reject(new WatchRequestRejected(message.error, message.retryAfterMs ?? null));
          }
        } else if (message.type === "pong") {
          this.lastPong = Date.now();
          const rtt = Date.now() - message.sentAtMs;
          if (rtt >= 0 && rtt < this.bestRtt) {
            this.bestRtt = rtt;
            this.offsetMs = message.serverTimeMs - (message.sentAtMs + rtt / 2);
          }
        } else if (message.type === "groups") this.update({ groups: message.groups });
        else if (message.type === "buffers") this.update({ buffers: message.buffers });
        else this.update({ group: message.group, error: null });
      } catch {
        socket.close(1002, "Invalid server message");
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      clearTimeout(timeout);
      if (this.socket === socket && event.code === WATCH_CONNECTION_REPLACED) {
        this.close();
        this.update({ connection: "unavailable", error: "Watch client connected elsewhere." });
        return;
      }
      this.disconnected(socket);
    };
  }

  private disconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    clearInterval(this.heartbeat);
    clearTimeout(this.rejoinTimer);
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
  }

  /**
   * Call after the device slept or lost its network. A socket that went quiet meanwhile is
   * replaced right away rather than after its heartbeat times out, and the clock offset is
   * measured again because timers do not run while a page is suspended.
   */
  resume(): void {
    if (this.stopped) return;
    this.bestRtt = Infinity;
    const socket = this.socket;
    if (socket === null) {
      clearTimeout(this.reconnectTimer);
      this.attempts = 0;
      this.connect();
    } else if (
      this.status.connection === "connected" &&
      Date.now() - this.lastPong > HEARTBEAT_TIMEOUT_MS / 2
    ) {
      this.attempts = 0;
      socket.close();
      // A dead connection may take a long time to report that it closed.
      this.disconnected(socket);
    }
  }

  get rejoining(): boolean {
    return this.desiredGroup !== null && this.group === null;
  }

  private async rejoin(): Promise<void> {
    const desired = this.desiredGroup;
    const socket = this.socket;
    if (desired === null || socket === null) return;
    try {
      await this.request({ type: "join", ...desired });
    } catch (cause) {
      if (
        this.socket !== socket ||
        this.desiredGroup !== desired ||
        !(cause instanceof WatchRequestRejected)
      )
        return;
      if (cause.retryAfterMs !== null) {
        this.update({ error: "Group is busy. Rejoining shortly…" });
        this.rejoinTimer = setTimeout(() => void this.rejoin(), cause.retryAfterMs);
      } else {
        this.desiredGroup = null;
        this.update({ group: null, error: cause.message });
      }
    }
  }

  /**
   * Asks the server to carry out an action. Where its outcome can be told in advance, `status`
   * shows it before this returns to the caller, and goes back to what the server last said if
   * the server refuses.
   */
  async action(action: WatchAction): Promise<void> {
    // A viewer who asked to leave is not brought back by a reconnect that lost the request.
    if (action.type === "leave") this.desiredGroup = null;
    await this.request(action);
    if (action.type === "create" && this.group !== null)
      this.desiredGroup = { groupId: this.group.id, password: action.password };
    if (action.type === "join")
      this.desiredGroup = { groupId: action.groupId, password: action.password };
  }

  close(): void {
    this.stopped = true;
    this.desiredGroup = null;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.rejoinTimer);
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
    const requestId = randomId();
    const memberId = this.status.memberId;
    const prediction =
      memberId === null
        ? null
        : predictWatchAction(
            action,
            this.status,
            { memberId, displayName: this.displayName, readiness: this.readiness },
            this.serverNow,
          );
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.settle(requestId);
        reject(new Error("Watch group request timed out"));
        socket.close();
      }, 10_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ requestId, action }));
      if (prediction !== null) {
        this.predictions.set(requestId, prediction);
        this.update();
      }
    });
  }

  /** The server answered or gave up on a request: the group is whatever it now says it is. */
  private settle(requestId: string): void {
    if (this.predictions.delete(requestId)) this.update();
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.predictions.clear();
  }

  private update(patch: Partial<WatchStatus> = {}): void {
    if (patch.group !== undefined) this.group = patch.group;
    let group = this.group;
    for (const prediction of this.predictions.values())
      if (prediction.awaits(group)) group = prediction.apply(group);
    this.status = { ...this.status, ...patch, group };
    // Buffers describe the members of a group; without one there is nobody to describe.
    if (group === null && this.status.buffers.length > 0)
      this.status = { ...this.status, buffers: [] };
    this.onStatus(this.status);
  }
}

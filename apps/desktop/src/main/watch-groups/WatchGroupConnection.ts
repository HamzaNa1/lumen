import {
  watchGroupScheduler,
  type WatchGroupScheduler,
  type CancelScheduled,
} from "@lumen/contracts";
import {
  GroupServerFrame,
  playbackRevision,
  snapshotPlaybackId,
  type GroupAction,
  type GroupClientFrame,
  type GroupCommand,
  type GroupCommandResult,
  type GroupMemberStatus,
  type GroupSnapshot,
} from "@lumen/contracts";
import { Schema } from "effect";
import { ServerClock } from "./ServerClock";
import type { GroupDiagnostic } from "./GroupDiagnostics";
export interface GroupConnectionApi {
  readonly serverOrigin: string;
  watchGroupTicket(groupId: string): Promise<{ ticket: string; serverInstanceId: string }>;
}
export interface GroupConnectionOptions {
  readonly diagnostic?: GroupDiagnostic;
  readonly api: GroupConnectionApi;
  readonly membership: GroupSnapshot;
  readonly onSnapshot: (snapshot: GroupSnapshot) => void;
  readonly onStatus: (
    status: "connecting" | "ready" | "reconnecting" | "ended",
    error: string | null,
  ) => void;
  readonly scheduler?: WatchGroupScheduler;
  readonly now?: () => number;
  readonly socket?: (url: string) => WebSocket;
  readonly random?: () => number;
}
export class WatchGroupConnection {
  readonly clock = new ServerClock();
  private socket: WebSocket | null = null;
  private generation = 0;
  private stopped = false;
  private connected = false;
  private attached = false;
  private snapshot: GroupSnapshot | null = null;
  private attempts = 0;
  private reconnects = 0;
  private disconnectedAt: number | null = null;
  private lastMessage = 0;
  private lastTick = 0;
  private reconnectTimer: CancelScheduled | null = null;
  private probeTimer: CancelScheduled | null = null;
  private readyTimer: CancelScheduled | null = null;
  private pending: {
    command: GroupCommand;
    resolve: (result: GroupCommandResult) => void;
    reject: (error: Error) => void;
    timer: CancelScheduled;
  } | null = null;
  private readonly now: () => number;
  private readonly scheduler: WatchGroupScheduler;
  constructor(private readonly options: GroupConnectionOptions) {
    this.scheduler = options.scheduler ?? watchGroupScheduler;
    this.now = options.now ?? (() => performance.now());
  }
  start(): void {
    if (!this.stopped) void this.connect();
  }
  get ready(): boolean {
    return this.connected && !this.stopped;
  }
  current(): GroupSnapshot | null {
    return this.snapshot;
  }
  async submit(action: GroupAction): Promise<GroupCommandResult> {
    if (!this.ready || this.snapshot === null)
      throw new Error("Watch group is reconnecting; controls are unavailable");
    if (this.pending !== null) throw new Error("A playback control is still pending");
    const command: GroupCommand = {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      expectedRevision: playbackRevision(this.snapshot),
      expectedPlaybackId: snapshotPlaybackId(this.snapshot),
      action,
    };
    return new Promise((resolve, reject) => {
      const timer = this.scheduler.after(10_000, () => {
        if (this.pending?.command.commandId !== command.commandId) return;
        this.pending = null;
        reject(new Error("Playback control timed out; check the current group state"));
        this.requestSnapshot();
      });
      this.pending = { command, resolve, reject, timer };
      this.send({ protocolVersion: 1, type: "command", command });
    });
  }
  requestSnapshot(): void {
    if (this.attached) this.send({ protocolVersion: 1, type: "request-snapshot" });
  }
  memberStatus(status: GroupMemberStatus): void {
    if (this.ready) this.send({ protocolVersion: 1, type: "member-status", status });
  }
  resume(): void {
    if (this.stopped) return;
    this.clock.reset();
    this.connected = false;
    this.attached = false;
    this.options.onStatus("reconnecting", null);
    this.socket?.close();
  }
  dispose(): void {
    this.stopped = true;
    this.generation++;
    this.connected = false;
    this.reconnectTimer?.();
    this.readyTimer?.();
    this.probeTimer?.();
    this.socket?.close();
    this.socket = null;
    this.clock.reset();
    this.rejectPending("Left the watch group");
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.connected = false;
    this.attached = false;
    this.clock.reset();
    this.options.onStatus(this.disconnectedAt === null ? "connecting" : "reconnecting", null);
    try {
      const ticket = await this.options.api.watchGroupTicket(this.options.membership.groupId);
      if (this.stopped || generation !== this.generation) return;
      if (ticket.serverInstanceId !== this.options.membership.serverInstanceId) {
        this.end("The server restarted. Join a new watch group.");
        return;
      }
      const url = new URL("/api/v1/watch-groups/socket", this.options.api.serverOrigin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = (this.options.socket ?? ((address) => new WebSocket(address)))(url.href);
      this.socket = socket;
      this.lastMessage = this.now();
      this.lastTick = this.now();
      this.readyTimer = this.scheduler.after(10_000, () => {
        if (!this.connected) socket.close();
      });
      socket.onopen = () => {
        if (generation === this.generation)
          this.send({ protocolVersion: 1, type: "authenticate", ticket: ticket.ticket });
      };
      socket.onmessage = (event) => {
        if (generation !== this.generation || this.stopped) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 65_536)
            throw new Error("Invalid watch group frame");
          const frame = Schema.decodeUnknownSync(GroupServerFrame)(JSON.parse(event.data));
          this.lastMessage = this.now();
          this.receive(frame);
        } catch {
          this.end("The server sent an unsupported watch group response");
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (generation === this.generation && !this.stopped) this.reconnect();
      };
      this.probeTimer?.();
      this.probeTimer = this.scheduler.every(5_000, () => {
        const now = this.now();
        if (now - this.lastTick > 15_000 || now - this.lastMessage > 15_000) {
          this.resume();
          return;
        }
        this.lastTick = now;
        this.probe();
      });
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404)
        this.end("Your membership ended. Sign in and join again.");
      else this.reconnect();
    }
  }
  private receive(frame: GroupServerFrame): void {
    if (frame.type === "membership-ended") {
      if (
        frame.code === "unavailable" ||
        frame.code === "rate_limited" ||
        frame.code === "capacity"
      )
        this.socket?.close();
      else
        this.end(
          frame.code === "server_restarted"
            ? "The server restarted. Join a new group."
            : "Your membership ended. Join again to watch together.",
        );
      return;
    }
    if (frame.type === "error") {
      this.rejectPending(`Watch group control failed: ${frame.code}`);
      return;
    }
    if (frame.type === "clock-pong") {
      if (frame.serverInstanceId !== this.options.membership.serverInstanceId) {
        this.end("The server restarted. Join a new group.");
        return;
      }
      this.clock.receive(frame.probeId, frame.t1, frame.t2, this.now());
      this.becomeReady();
      return;
    }
    const incoming = frame.type === "snapshot" ? frame.snapshot : frame.result.snapshot;
    if (
      incoming.serverInstanceId !== this.options.membership.serverInstanceId ||
      incoming.groupId !== this.options.membership.groupId ||
      incoming.membershipId !== this.options.membership.membershipId
    ) {
      this.end("Watch group identity changed. Join again.");
      return;
    }
    if (this.snapshot === null || playbackRevision(incoming) >= playbackRevision(this.snapshot)) {
      this.snapshot =
        this.snapshot !== null && incoming.rosterRevision < this.snapshot.rosterRevision
          ? {
              ...incoming,
              members: this.snapshot.members,
              rosterRevision: this.snapshot.rosterRevision,
            }
          : incoming;
      this.options.onSnapshot(this.snapshot);
    }
    if (!this.attached) {
      this.attached = true;
      for (let i = 0; i < 4; i++) this.probe();
    }
    this.becomeReady();
    if (
      frame.type === "command-result" &&
      this.pending?.command.commandId === frame.result.commandId
    ) {
      const pending = this.pending;
      this.pending = null;
      pending.timer();
      pending.resolve(frame.result);
    }
  }
  private becomeReady(): void {
    if (this.connected || !this.attached || this.clock.estimate(this.now()) === null) return;
    this.connected = true;
    this.attempts = 0;
    this.disconnectedAt = null;
    this.readyTimer?.();
    this.options.onStatus("ready", null);
    if (this.pending !== null)
      this.send({ protocolVersion: 1, type: "command", command: this.pending.command });
  }
  private probe(): void {
    if (!this.attached) return;
    const probeId = crypto.randomUUID();
    this.clock.begin(probeId, this.now());
    this.send({ protocolVersion: 1, type: "clock-ping", probeId });
  }
  private send(frame: GroupClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
  private reconnect(): void {
    this.reconnects++;
    this.options.diagnostic?.("watch_group_reconnect", { count: this.reconnects });
    this.generation++;
    this.connected = false;
    this.attached = false;
    this.clock.reset();
    this.readyTimer?.();
    this.probeTimer?.();
    this.disconnectedAt ??= this.now();
    if (this.now() - this.disconnectedAt >= 30_000) {
      this.end("The connection expired. Join the group again.");
      return;
    }
    this.options.onStatus("reconnecting", null);
    const delay =
      Math.min(10_000, 300 * 2 ** Math.min(6, this.attempts++)) *
      (0.75 + (this.options.random ?? Math.random)() * 0.25);
    this.reconnectTimer?.();
    this.reconnectTimer = this.scheduler.after(delay, () => void this.connect());
  }
  private rejectPending(message: string): void {
    if (this.pending === null) return;
    this.pending.timer();
    this.pending.reject(new Error(message));
    this.pending = null;
  }
  private end(message: string): void {
    this.dispose();
    this.options.onStatus("ended", message);
  }
}

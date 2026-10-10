import {
  CatalogItemDetails,
  WATCH_BUFFER_REPORT_INTERVAL_MS,
  WATCH_CONNECTION_REPLACED,
  WATCH_HEARTBEAT_INTERVAL_MS,
  WATCH_MEMBER_TIMEOUT_MS,
  WatchConnect,
  WatchRequest,
  watchPosition,
  type WatchGroup,
  type WatchMemberBuffer,
  type WatchMessage,
  type WatchPlayback,
} from "@lumen/contracts";
import { Effect, Schema } from "effect";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { HttpServices } from "../http/HttpApp";
import type { AuthPrincipal } from "../services/AuthService";
import type { Logger } from "../core/Logger";
import { RequestLimiter } from "../core/Limits";
import { hashPassword, verifyPassword } from "../core/Security";
import { requestOrigin, sessionCookieToken } from "../http/BrowserSession";

export interface WatchSocketData {
  readonly id: string;
  readonly sequence: number;
  /** The session cookie sent with a same-origin browser's upgrade request, if any. */
  readonly cookieToken: string | null;
  token: string | null;
  clientKey: string | null;
  lastActivityAtMs: number;
  principal: AuthPrincipal | null;
  /** This client says when it has buffered a position, so its group can wait for it. */
  readiness: boolean;
  /** This client asked to be told how its group's members are buffered. */
  buffers: boolean;
  /** How this member's player last said it was buffered, and for which item. */
  buffer: (Omit<WatchMemberBuffer, "memberId"> & { itemId: string; reportedAtMs: number }) | null;
  /** The `buffers` this socket was last sent, serialized, so that only changes are sent. */
  sentBuffers: string;
  groupId: string | null;
  queue: Promise<void>;
  pending: number;
  windowStart: number;
  messages: number;
  closed: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
}
interface ClientConnection {
  socket: ServerWebSocket<WatchSocketData> | null;
  readonly sequence: number;
  retiredAtMs: number | null;
}
interface Group {
  state: WatchGroup;
  readonly passwordHash: string | null;
  emptySince: number | null;
}
interface StateDelivery {
  group: Group;
  sentState: WatchGroup | null;
  promise: Promise<void>;
}
interface DirectoryDelivery {
  revision: number;
  sentRevision: number;
  promise: Promise<void>;
}
type WatchServices = {
  readonly auth: Pick<HttpServices["auth"], "authenticate">;
  readonly catalog: Pick<HttpServices["catalog"], "itemDetails">;
  readonly access: Pick<HttpServices["access"], "requireLibrary">;
};
const BUFFER_SHARE_INTERVAL_MS = 1000;
// A player that has gone quiet is no longer described by what it last said.
const BUFFER_REPORT_LIFETIME_MS = 3 * WATCH_BUFFER_REPORT_INTERVAL_MS;
const NO_BUFFERS = "[]";

type TrustedOrigin = (request: Request, origin: string) => boolean;

class WatchGroupsBusy extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 1000,
  ) {
    super(message);
  }
}

export class WatchGroups {
  private readonly sockets = new Set<ServerWebSocket<WatchSocketData>>();
  private readonly clients = new Map<string, ClientConnection>();
  private nextSequence = 0;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;
  private readonly groups = new Map<string, Group>();
  private readonly deliveries = new Map<ServerWebSocket<WatchSocketData>, StateDelivery>();
  private readonly directories = new Map<ServerWebSocket<WatchSocketData>, DirectoryDelivery>();
  private passwordOperations = 0;
  private readonly attempts = new RequestLimiter({
    maxRequests: 10,
    loginRequests: 10,
    maxActive: 4,
  });
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly bufferTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly services: WatchServices,
    private readonly trustedOrigin: TrustedOrigin = (request, origin) =>
      origin === requestOrigin(request),
    options: { readonly now?: () => number; readonly logger?: Logger } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.timer = setInterval(() => this.sweep(), WATCH_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    this.bufferTimer = setInterval(() => this.shareBuffers(), BUFFER_SHARE_INTERVAL_MS);
    this.bufferTimer.unref();
  }

  upgrade(request: Request, server: Bun.Server<WatchSocketData>): Response | undefined {
    if (this.sockets.size >= 256) return new Response("Watch groups are busy", { status: 503 });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // Desktop sockets have no Origin. Browser callers must be same-origin.
    const origin = request.headers.get("origin");
    if (origin !== null && !this.trustedOrigin(request, origin))
      return new Response(null, { status: 403 });
    const upgraded = server.upgrade(request, {
      data: {
        id: crypto.randomUUID(),
        sequence: this.nextSequence++,
        // Only a browser on this origin may stand on its cookie; a socket without an Origin
        // header is not a browser page and must present a token.
        cookieToken: origin === null ? null : sessionCookieToken(request),
        token: null,
        clientKey: null,
        lastActivityAtMs: this.now(),
        principal: null,
        readiness: false,
        buffers: false,
        buffer: null,
        sentBuffers: NO_BUFFERS,
        groupId: null,
        queue: Promise.resolve(),
        pending: 0,
        windowStart: this.now(),
        messages: 0,
        closed: false,
      },
    });
    return upgraded ? undefined : new Response("WebSocket required", { status: 426 });
  }

  readonly websocket: WebSocketHandler<WatchSocketData> = {
    maxPayloadLength: 4096,
    idleTimeout: 30,
    backpressureLimit: 128 * 1024,
    closeOnBackpressureLimit: true,
    open: (socket) => {
      this.sockets.add(socket);
      socket.data.authTimer = setTimeout(
        () => this.retire(socket, 1008, "Authentication required"),
        5000,
      );
    },
    message: (socket, raw) => {
      const data = socket.data;
      if (data.closed) return;
      if (this.now() - data.windowStart >= 60_000) {
        data.windowStart = this.now();
        data.messages = 0;
      }
      if (++data.messages > 240 || data.pending >= 8 || typeof raw !== "string") {
        this.retire(socket, 1008, "Request limit exceeded");
        return;
      }
      data.lastActivityAtMs = this.now();
      data.pending += 1;
      data.queue = data.queue
        .then(() => this.receive(socket, raw))
        .catch(() => {
          this.retire(socket, 1008, "Invalid watch group request");
        })
        .finally(() => {
          data.pending -= 1;
        });
    },
    close: (socket) => this.retire(socket),
  };

  /** Also called by the periodic maintenance timer; transport pongs do not renew this lease. */
  sweep(): void {
    const now = this.now();
    this.attempts.sweep(now);
    for (const socket of this.sockets) {
      if (now - socket.data.lastActivityAtMs >= WATCH_MEMBER_TIMEOUT_MS)
        this.retire(socket, 1001, "Watch client heartbeat expired");
    }
    for (const [key, client] of this.clients) {
      if (client.retiredAtMs !== null && now - client.retiredAtMs >= WATCH_MEMBER_TIMEOUT_MS)
        this.clients.delete(key);
    }
    for (const [id, group] of this.groups) {
      if (group.emptySince !== null && now - group.emptySince > 30_000) this.groups.delete(id);
    }
  }

  close(): void {
    clearInterval(this.timer);
    clearInterval(this.bufferTimer);
    for (const socket of this.sockets) this.retire(socket, 1001, "Server stopping");
    this.groups.clear();
    this.clients.clear();
  }

  /** Retire immediately, without waiting for the transport's close callback or pending work. */
  private retire(socket: ServerWebSocket<WatchSocketData>, code?: number, reason?: string): void {
    const data = socket.data;
    if (data.closed) return;
    data.closed = true;
    clearTimeout(data.authTimer);
    this.sockets.delete(socket);
    const client = this.clients.get(data.clientKey ?? "");
    if (client?.socket === socket) {
      // Keep the generation briefly: authentication from an older upgrade can finish late,
      // even after the successor has left. It must not reclaim this logical client.
      client.socket = null;
      client.retiredAtMs = this.now();
    }
    this.deliveries.delete(socket);
    this.directories.delete(socket);
    this.logger?.info("watch_connection_retired", {
      memberId: data.id,
      groupId: data.groupId,
      userId: data.principal?.user.id,
      reason: reason ?? "Connection closed",
    });
    this.leave(socket);
    data.token = null;
    data.principal = null;
    if (code !== undefined) socket.close(code, reason);
  }

  /** Claim only after authentication: independent clients, users, and sessions stay separate. */
  private claim(
    socket: ServerWebSocket<WatchSocketData>,
    principal: AuthPrincipal,
    authentication: typeof WatchConnect.Type,
  ): void {
    if (authentication.clientId === undefined) return;
    const key = JSON.stringify([principal.user.id, principal.sessionId, authentication.clientId]);
    const current = this.clients.get(key);
    if (current !== undefined && current.sequence > socket.data.sequence) {
      this.retire(socket, WATCH_CONNECTION_REPLACED, "Watch connection replaced");
      return;
    }
    const previous = current?.socket;
    socket.data.clientKey = key;
    this.clients.set(key, { socket, sequence: socket.data.sequence, retiredAtMs: null });
    if (previous == null) return;
    const group = this.groups.get(previous.data.groupId ?? "");
    if (group !== undefined && authentication.resumeGroupId === group.state.id) {
      // Install the successor before retiring the old socket. Its wait and buffer are fresh,
      // and removing the old member can never briefly release an existing readiness hold.
      previous.data.groupId = null;
      this.enterGroup(socket, group, principal.user.displayName, previous.data.id);
    }
    this.logger?.info("watch_connection_replaced", {
      memberId: socket.data.id,
      previousMemberId: previous.data.id,
      groupId: group?.state.id,
      userId: principal.user.id,
    });
    this.retire(previous, WATCH_CONNECTION_REPLACED, "Watch connection replaced");
    if (group !== undefined) {
      this.directory();
      void this.publish(group);
    }
  }

  private send(socket: ServerWebSocket<WatchSocketData>, message: WatchMessage): void {
    if (!socket.data.closed) socket.send(JSON.stringify(message));
  }

  private list(socket: ServerWebSocket<WatchSocketData>): Promise<void> {
    const running = this.directories.get(socket);
    if (running !== undefined) {
      running.revision += 1;
      return running.promise;
    }
    const delivery: DirectoryDelivery = {
      revision: 0,
      sentRevision: -1,
      promise: Promise.resolve(),
    };
    delivery.promise = this.visibleDirectory(socket, delivery)
      .then(() => {
        this.directories.delete(socket);
        if (
          !socket.data.closed &&
          socket.data.token !== null &&
          delivery.sentRevision !== delivery.revision
        )
          void this.list(socket);
      })
      .catch(() => {
        this.directories.delete(socket);
        this.retire(socket, 1011, "Could not check media access");
      });
    this.directories.set(socket, delivery);
    return delivery.promise;
  }

  private async authenticate(
    socket: ServerWebSocket<WatchSocketData>,
  ): Promise<AuthPrincipal | null> {
    const token = socket.data.token;
    if (token === null || socket.data.closed) return null;
    try {
      const principal = await Effect.runPromise(this.services.auth.authenticate(token, this.now()));
      if (socket.data.closed || socket.data.token !== token) return null;
      socket.data.principal = principal;
      return principal;
    } catch {
      this.retire(socket, 1008, "Sign-in required");
      return null;
    }
  }

  private mediaVisible(principal: AuthPrincipal, itemId: string): Promise<boolean> {
    return Effect.runPromise(
      this.services.catalog
        .itemDetails(principal, itemId, false, this.now())
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
    );
  }

  private async visibleGroup(principal: AuthPrincipal, state: WatchGroup): Promise<WatchGroup> {
    if (state.playback === null) return state;
    return (await this.mediaVisible(principal, state.playback.itemId))
      ? state
      : { ...state, playback: null };
  }

  private async visibleDirectory(
    socket: ServerWebSocket<WatchSocketData>,
    delivery: DirectoryDelivery,
  ): Promise<void> {
    const revision = delivery.revision;
    const principal = await this.authenticate(socket);
    if (principal === null) return;
    const itemIds = new Set(
      [...this.groups.values()]
        .filter(({ state }) => state.members.length > 0)
        .flatMap(({ state }) => (state.playback === null ? [] : [state.playback.itemId])),
    );
    const visibility = new Map<string, boolean>();
    for (const itemId of itemIds) {
      visibility.set(itemId, await this.mediaVisible(principal, itemId));
      if (socket.data.closed || socket.data.token === null) return;
    }
    if (socket.data.closed || socket.data.token === null) return;
    const groups = [...this.groups.values()]
      .map(({ state }) => state)
      .filter((state) => state.members.length > 0)
      .map((state) =>
        state.playback === null || visibility.get(state.playback.itemId) === true
          ? state
          : { ...state, playback: null },
      );
    this.send(socket, { type: "groups", groups });
    delivery.sentRevision = revision;
  }

  private async publish(group: Group): Promise<void> {
    const deliveries: Promise<void>[] = [];
    for (const socket of this.sockets) {
      if (socket.data.groupId === group.state.id) deliveries.push(this.deliverState(socket, group));
    }
    await Promise.all(deliveries);
  }

  private deliverState(socket: ServerWebSocket<WatchSocketData>, group: Group): Promise<void> {
    const running = this.deliveries.get(socket);
    if (running !== undefined) {
      running.group = group;
      return running.promise;
    }
    const delivery: StateDelivery = { group, sentState: null, promise: Promise.resolve() };
    delivery.promise = this.visibleState(socket, delivery)
      .then(async () => {
        this.deliveries.delete(socket);
        if (
          !socket.data.closed &&
          socket.data.groupId === delivery.group.state.id &&
          delivery.group.state !== delivery.sentState
        )
          await this.deliverState(socket, delivery.group);
      })
      .catch(() => {
        this.deliveries.delete(socket);
        this.retire(socket, 1011, "Could not check media access");
      });
    this.deliveries.set(socket, delivery);
    return delivery.promise;
  }

  private async visibleState(
    socket: ServerWebSocket<WatchSocketData>,
    delivery: StateDelivery,
  ): Promise<void> {
    while (!socket.data.closed && socket.data.groupId === delivery.group.state.id) {
      const group = delivery.group;
      const state = group.state;
      const principal = await this.authenticate(socket);
      if (principal === null) return;
      const visible = await this.visibleGroup(principal, state);
      if (socket.data.closed || socket.data.groupId !== delivery.group.state.id) return;
      // A member who cannot see the media is not going to load it.
      if (visible.playback === null) this.ready(group, socket.data.id, state.revision);
      // Coalesce publications while access checks run; never send a superseded snapshot.
      if (delivery.group !== group || group.state !== state) continue;
      this.send(socket, { type: "state", group: visible });
      delivery.sentState = state;
      return;
    }
  }

  private directory(): void {
    for (const socket of this.sockets) if (socket.data.token !== null) void this.list(socket);
  }

  private enterGroup(
    socket: ServerWebSocket<WatchSocketData>,
    group: Group,
    displayName: string,
    replaces?: string,
  ): void {
    socket.data.groupId = group.state.id;
    group.emptySince = null;
    const member = { id: socket.data.id, displayName };
    const playback = group.state.playback;
    group.state = {
      ...group.state,
      members:
        replaces === undefined
          ? [...group.state.members, member]
          : group.state.members.map((previous) => (previous.id === replaces ? member : previous)),
      // Preserve the hold's position and revision. Existing viewers are still loading there,
      // but the successor must report its own readiness, even if its predecessor was ready.
      playback:
        playback?.waitingFor === undefined
          ? playback
          : {
              ...playback,
              waitingFor: [
                ...playback.waitingFor.filter((id) => id !== replaces),
                ...(socket.data.readiness ? [socket.data.id] : []),
              ],
            },
    };
    if (socket.data.readiness && playback !== null) this.hold(group, group.state.revision);
    else if (group.state.playback?.waitingFor?.length === 0)
      this.release(group, group.state.revision);
  }

  private leave(socket: ServerWebSocket<WatchSocketData>): void {
    const group = this.groups.get(socket.data.groupId ?? "");
    socket.data.groupId = null;
    socket.data.buffer = null;
    // A client forgets the buffers of a group it has left.
    socket.data.sentBuffers = NO_BUFFERS;
    if (group !== undefined) {
      group.state = {
        ...group.state,
        members: group.state.members.filter((member) => member.id !== socket.data.id),
      };
      if (group.state.members.length === 0) group.emptySince = this.now();
      this.ready(group, socket.data.id, group.state.revision);
      void this.publish(group);
      this.directory();
    }
    this.shareBuffers();
    this.send(socket, { type: "state", group: null });
  }

  /**
   * Tells the members that asked how each other's players are buffered, where that has changed.
   * It goes out on its own clock rather than with the group's state: players report often, and
   * none of it bears on what the group plays.
   */
  private shareBuffers(): void {
    const now = this.now();
    const buffers = new Map<string, WatchMemberBuffer[]>();
    for (const { data } of this.sockets) {
      if (data.groupId === null || data.buffer === null) continue;
      const { itemId, reportedAtMs, ...buffer } = data.buffer;
      if (
        this.groups.get(data.groupId)?.state.playback?.itemId !== itemId ||
        now - reportedAtMs > BUFFER_REPORT_LIFETIME_MS
      ) {
        data.buffer = null;
        continue;
      }
      const group = buffers.get(data.groupId) ?? [];
      group.push({ memberId: data.id, ...buffer });
      buffers.set(data.groupId, group);
    }
    for (const socket of this.sockets) {
      const { data } = socket;
      if (!data.buffers || data.groupId === null) continue;
      const group = buffers.get(data.groupId) ?? [];
      const serialized = JSON.stringify(group);
      if (serialized === data.sentBuffers) continue;
      data.sentBuffers = serialized;
      this.send(socket, { type: "buffers", buffers: group });
    }
  }

  /**
   * Moves the group to a position it is to play from. Members that report readiness get to
   * buffer it first: the group holds there, paused, for as long as any of them takes, so nobody
   * starts out behind a clock that is already running. A member that leaves, disconnects, or
   * says its device will not play is no longer waited for.
   */
  private playFrom(
    group: Group,
    position: Pick<WatchPlayback, "itemId" | "title" | "positionSeconds">,
  ): void {
    const waitingFor = [...this.sockets]
      .filter(({ data }) => data.groupId === group.state.id && data.readiness)
      .map(({ data }) => data.id);
    const revision = group.state.revision + 1;
    const held = waitingFor.length > 0;
    group.state = {
      ...group.state,
      revision,
      playback: {
        ...position,
        paused: held,
        updatedAtMs: this.now(),
        ...(held ? { waitingFor } : {}),
      },
    };
  }

  /** Leaves the group at rest, no longer about to play: paused at a position, or with nothing on. */
  private restAt(
    group: Group,
    position: Pick<WatchPlayback, "itemId" | "title" | "positionSeconds"> | null,
  ): void {
    group.state = {
      ...group.state,
      revision: group.state.revision + 1,
      playback: position === null ? null : { ...position, paused: true, updatedAtMs: this.now() },
    };
  }

  /**
   * Holds a playing group where its clock has reached, so its members can buffer there.
   */
  private hold(group: Group, revision: number): boolean {
    const playback = group.state.playback;
    if (group.state.revision !== revision || playback === null || playback.paused) return false;
    this.playFrom(group, {
      itemId: playback.itemId,
      title: playback.title,
      positionSeconds: watchPosition(playback, this.now()),
    });
    return true;
  }

  /** Starts a held group playing, unless it has moved on since that revision. */
  private release(group: Group, revision: number): void {
    const playback = group.state.playback;
    if (group.state.revision !== revision || playback?.waitingFor === undefined) return;
    const { waitingFor: _waitingFor, ...position } = playback;
    group.state = {
      ...group.state,
      revision: revision + 1,
      playback: { ...position, paused: false, updatedAtMs: this.now() },
    };
    this.directory();
    void this.publish(group);
  }

  /** A held group no longer waits for this member; it plays once it waits for nobody. */
  private ready(group: Group, memberId: string, revision: number): void {
    const playback = group.state.playback;
    if (group.state.revision !== revision || playback?.waitingFor?.includes(memberId) !== true)
      return;
    const waitingFor = playback.waitingFor.filter((id) => id !== memberId);
    if (waitingFor.length === 0) {
      this.release(group, revision);
      return;
    }
    // The revision stays: members still loading must not be told to start over.
    group.state = { ...group.state, playback: { ...playback, waitingFor } };
    void this.publish(group);
  }

  private async passwordWork<A>(operation: () => Promise<A>): Promise<A> {
    if (this.passwordOperations >= 4)
      throw new WatchGroupsBusy("Watch groups are busy. Try again shortly.");
    this.passwordOperations += 1;
    try {
      return await operation();
    } finally {
      this.passwordOperations -= 1;
    }
  }

  private async receive(socket: ServerWebSocket<WatchSocketData>, raw: string): Promise<void> {
    if (socket.data.closed) return;
    const value: unknown = JSON.parse(raw);
    if (socket.data.token === null) {
      const authentication = Schema.decodeUnknownSync(WatchConnect)(value);
      const token = "token" in authentication ? authentication.token : socket.data.cookieToken;
      if (token === null) throw new Error("Sign-in required");
      const principal = await Effect.runPromise(this.services.auth.authenticate(token, this.now()));
      if (socket.data.closed) return;
      socket.data.token = token;
      socket.data.principal = principal;
      socket.data.readiness = authentication.readiness === true;
      socket.data.buffers = authentication.buffers === true;
      clearTimeout(socket.data.authTimer);
      this.claim(socket, principal, authentication);
      if (socket.data.closed) return;
      this.send(socket, {
        type: "ready",
        memberId: socket.data.id,
        holdsForBuffering: true,
        sharesBuffers: true,
        displayName: principal.user.displayName,
      });
      void this.list(socket);
      return;
    }
    const { requestId, action } = Schema.decodeUnknownSync(WatchRequest)(value);
    try {
      const principal = await this.authenticate(socket);
      if (principal === null) return;
      if (action.type === "ping") {
        const group = this.groups.get(socket.data.groupId ?? "");
        void this.list(socket);
        if (group !== undefined) void this.deliverState(socket, group);
        this.send(socket, { type: "pong", sentAtMs: action.sentAtMs, serverTimeMs: this.now() });
      } else if (action.type === "ready") {
        const group = this.groups.get(socket.data.groupId ?? "");
        if (group !== undefined) this.ready(group, socket.data.id, action.revision);
      } else if (action.type === "buffering") {
        const group = this.groups.get(socket.data.groupId ?? "");
        // Only a member that reports readiness can end the wait it is asking for.
        if (group !== undefined && socket.data.readiness && this.hold(group, action.revision)) {
          this.directory();
          void this.publish(group);
        }
      } else if (action.type === "buffer") {
        const { type: _type, ...buffer } = action;
        // A report about something the group has moved on from describes nothing it has on.
        if (this.groups.get(socket.data.groupId ?? "")?.state.playback?.itemId === action.itemId) {
          const first = socket.data.buffer === null;
          socket.data.buffer = { ...buffer, reportedAtMs: this.now() };
          // Until a member's player has said anything, the others are shown it as unknown.
          if (first) this.shareBuffers();
        }
      } else if (action.type === "list") await this.list(socket);
      else if (action.type === "leave") this.leave(socket);
      else if (action.type === "create" || action.type === "join") {
        const retrySeconds = await Effect.runPromise(
          this.attempts.check(principal.user.id, this.now()).pipe(
            Effect.match({
              onFailure: (failure) => failure.retryAfterSeconds,
              onSuccess: () => 0,
            }),
          ),
        );
        if (socket.data.closed) return;
        if (retrySeconds > 0)
          throw new WatchGroupsBusy(
            "Too many attempts. Try again shortly.",
            Math.min(60000, retrySeconds * 1000),
          );
        let group: Group;
        if (action.type === "create") {
          if (this.groups.size >= 64) throw new Error("Too many watch groups. Try again later.");
          const name = action.name.trim();
          if (name.length === 0) throw new Error("Enter a group name");
          const passwordHash =
            action.password === ""
              ? null
              : await this.passwordWork(() => hashPassword(action.password));
          group = {
            state: {
              id: crypto.randomUUID(),
              name,
              hasPassword: passwordHash !== null,
              members: [],
              playback: null,
              revision: 0,
            },
            passwordHash,
            emptySince: null,
          };
        } else {
          const found = this.groups.get(action.groupId);
          if (found === undefined) throw new Error("This group is no longer available");
          group = found;
          if (
            group.passwordHash !== null &&
            !(await this.passwordWork(() =>
              verifyPassword(action.password, group.passwordHash ?? ""),
            ))
          )
            throw new Error("Incorrect group password");
          if (this.groups.get(action.groupId) !== group)
            throw new Error("This group is no longer available");
        }
        if (socket.data.closed) return;
        const alreadyJoined = socket.data.groupId === group.state.id;
        if (!alreadyJoined && group.state.members.length >= 32)
          throw new WatchGroupsBusy("This group is full", 5000);
        if (action.type === "create" && this.groups.size >= 64)
          throw new Error("Too many watch groups. Try again later.");
        if (!alreadyJoined) {
          this.leave(socket);
          this.groups.set(group.state.id, group);
          this.enterGroup(socket, group, principal.user.displayName);
        }
        this.directory();
        await this.publish(group);
      } else {
        const group = this.groups.get(socket.data.groupId ?? "");
        if (group === undefined) throw new Error("Join a watch group first");
        const previous = group.state;
        const details = Schema.decodeUnknownSync(CatalogItemDetails)(
          await Effect.runPromise(
            this.services.catalog.itemDetails(principal, action.itemId, false, this.now()),
          ),
        );
        await Effect.runPromise(
          this.services.access.requireLibrary(
            principal,
            details.item.libraryId,
            "playback:control",
            this.now(),
          ),
        );
        if (socket.data.closed || socket.data.groupId !== group.state.id) return;
        // A request to play in place of something says itself what it expects of the group.
        const replaces = action.type === "play" ? action.replaces : undefined;
        if (replaces === undefined && group.state.revision !== previous.revision)
          throw new Error("Group changed. Try again.");
        if (action.type === "play") {
          if (details.item.kind === "show" || details.item.kind === "season")
            throw new Error("Choose a movie or episode");
          // Another member already moved the group on; asking again must not start that over.
          if (replaces === undefined || group.state.playback?.itemId === replaces)
            this.playFrom(group, {
              itemId: action.itemId,
              title: details.item.title,
              positionSeconds: action.positionSeconds,
            });
        } else {
          const playback = previous.playback;
          if (playback === null || playback.itemId !== action.itemId)
            throw new Error("The group is watching something else");
          if (action.type === "stop") this.restAt(group, null);
          else {
            const position = {
              itemId: playback.itemId,
              title: playback.title,
              positionSeconds: action.positionSeconds,
            };
            // A held group is one that is playing; it only looks paused while its members load.
            const held = playback.waitingFor !== undefined;
            const plays = action.type === "pause" ? !action.paused : held || !playback.paused;
            if (!plays) this.restAt(group, position);
            // Asking a group that is about to play to play changes nothing; it is still loading.
            else if (action.type === "seek" || !held) this.playFrom(group, position);
          }
        }
        this.directory();
        await this.publish(group);
      }
      this.send(socket, { type: "reply", requestId, error: null });
    } catch (cause) {
      this.send(socket, {
        type: "reply",
        requestId,
        ...(cause instanceof WatchGroupsBusy ? { retryAfterMs: cause.retryAfterMs } : {}),
        error:
          cause instanceof Error && !cause.message.includes("\n")
            ? cause.message
            : "Watch group request failed",
      });
    }
  }
}

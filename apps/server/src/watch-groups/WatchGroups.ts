import { IpcItemDetails, WatchRequest, type WatchGroup, type WatchMessage } from "@lumen/contracts";
import { Effect, Schema } from "effect";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { HttpServices } from "../http/HttpApp";
import type { AuthPrincipal } from "../services/AuthService";
import { RequestLimiter } from "../core/Limits";
import { hashPassword, verifyPassword } from "../core/Security";

export interface WatchSocketData {
  readonly id: string;
  token: string | null;
  principal: AuthPrincipal | null;
  groupId: string | null;
  queue: Promise<void>;
  pending: number;
  windowStart: number;
  messages: number;
  closed: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
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
type WatchServices = {
  readonly auth: Pick<HttpServices["auth"], "authenticate">;
  readonly catalog: Pick<HttpServices["catalog"], "itemDetails">;
  readonly access: Pick<HttpServices["access"], "requireLibrary">;
};
const Authentication = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});

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
  private readonly groups = new Map<string, Group>();
  private readonly deliveries = new Map<ServerWebSocket<WatchSocketData>, StateDelivery>();
  private passwordOperations = 0;
  private readonly attempts = new RequestLimiter({
    maxRequests: 10,
    loginRequests: 10,
    maxActive: 4,
  });
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly services: WatchServices) {
    this.timer = setInterval(() => {
      this.attempts.sweep(Date.now());
      for (const [id, group] of this.groups) {
        if (group.emptySince !== null && Date.now() - group.emptySince > 30_000)
          this.groups.delete(id);
      }
    }, 5000);
    this.timer.unref();
  }

  upgrade(request: Request, server: Bun.Server<WatchSocketData>): Response | undefined {
    if (this.sockets.size >= 256) return new Response("Watch groups are busy", { status: 503 });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // Desktop sockets have no Origin. Browser callers must be same-origin.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== new URL(request.url).origin)
      return new Response(null, { status: 403 });
    const upgraded = server.upgrade(request, {
      data: {
        id: crypto.randomUUID(),
        token: null,
        principal: null,
        groupId: null,
        queue: Promise.resolve(),
        pending: 0,
        windowStart: Date.now(),
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
      socket.data.authTimer = setTimeout(() => socket.close(1008, "Authentication required"), 5000);
    },
    message: (socket, raw) => {
      const data = socket.data;
      if (Date.now() - data.windowStart >= 60_000) {
        data.windowStart = Date.now();
        data.messages = 0;
      }
      if (++data.messages > 240 || data.pending >= 8 || typeof raw !== "string") {
        socket.close(1008, "Request limit exceeded");
        return;
      }
      data.pending += 1;
      data.queue = data.queue
        .then(() => this.receive(socket, raw))
        .catch(() => {
          socket.close(1008, "Invalid watch group request");
        })
        .finally(() => {
          data.pending -= 1;
        });
    },
    close: (socket) => {
      socket.data.closed = true;
      clearTimeout(socket.data.authTimer);
      this.sockets.delete(socket);
      this.leave(socket);
    },
  };

  close(): void {
    clearInterval(this.timer);
    for (const socket of this.sockets) socket.close(1001, "Server stopping");
    this.groups.clear();
  }

  private send(socket: ServerWebSocket<WatchSocketData>, message: WatchMessage): void {
    if (!socket.data.closed) socket.send(JSON.stringify(message));
  }

  private list(socket: ServerWebSocket<WatchSocketData>): void {
    // The directory contains names and participants, never a group's media state.
    this.send(socket, {
      type: "groups",
      groups: [...this.groups.values()]
        .filter((group) => group.state.members.length > 0)
        .map(({ state }) => ({ ...state, playback: null })),
    });
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
        socket.close(1011, "Could not check media access");
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
      const token = socket.data.token;
      if (token === null) return;
      let principal: AuthPrincipal;
      try {
        principal = await Effect.runPromise(this.services.auth.authenticate(token, Date.now()));
      } catch {
        this.leave(socket);
        socket.data.principal = null;
        socket.close(1008, "Sign-in required");
        return;
      }
      let visible = true;
      if (state.playback !== null) {
        visible = await Effect.runPromise(
          this.services.catalog
            .itemDetails(principal, state.playback.itemId, false, Date.now())
            .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
        );
      }
      if (socket.data.closed || socket.data.groupId !== delivery.group.state.id) return;
      // Coalesce publications while access checks run; never send a superseded snapshot.
      if (delivery.group !== group || group.state !== state) continue;
      this.send(socket, { type: "state", group: visible ? state : { ...state, playback: null } });
      delivery.sentState = state;
      return;
    }
  }

  private directory(): void {
    for (const socket of this.sockets) if (socket.data.principal !== null) this.list(socket);
  }

  private leave(socket: ServerWebSocket<WatchSocketData>): void {
    const group = this.groups.get(socket.data.groupId ?? "");
    socket.data.groupId = null;
    if (group !== undefined) {
      group.state = {
        ...group.state,
        members: group.state.members.filter((member) => member.id !== socket.data.id),
      };
      if (group.state.members.length === 0) group.emptySince = Date.now();
      void this.publish(group);
      this.directory();
    }
    this.send(socket, { type: "state", group: null });
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
      const { token } = Schema.decodeUnknownSync(Authentication)(value);
      const principal = await Effect.runPromise(this.services.auth.authenticate(token, Date.now()));
      if (socket.data.closed) return;
      socket.data.token = token;
      socket.data.principal = principal;
      clearTimeout(socket.data.authTimer);
      this.send(socket, { type: "ready", memberId: socket.data.id });
      this.list(socket);
      return;
    }
    const { requestId, action } = Schema.decodeUnknownSync(WatchRequest)(value);
    try {
      let principal: AuthPrincipal;
      try {
        principal = await Effect.runPromise(
          this.services.auth.authenticate(socket.data.token, Date.now()),
        );
      } catch {
        this.leave(socket);
        socket.data.principal = null;
        socket.close(1008, "Sign-in required");
        return;
      }
      if (socket.data.closed) return;
      socket.data.principal = principal;
      if (action.type === "ping") {
        const group = this.groups.get(socket.data.groupId ?? "");
        if (group !== undefined) await this.deliverState(socket, group);
        this.send(socket, { type: "pong", sentAtMs: action.sentAtMs, serverTimeMs: Date.now() });
      } else if (action.type === "list") this.list(socket);
      else if (action.type === "leave") this.leave(socket);
      else if (action.type === "create" || action.type === "join") {
        const retrySeconds = await Effect.runPromise(
          this.attempts.check(principal.user.id, Date.now()).pipe(
            Effect.match({
              onFailure: (failure) => failure.retryAfterSeconds,
              onSuccess: () => 0,
            }),
          ),
        );
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
        if (group.state.members.length >= 32) throw new WatchGroupsBusy("This group is full", 5000);
        if (action.type === "create" && this.groups.size >= 64)
          throw new Error("Too many watch groups. Try again later.");
        this.leave(socket);
        this.groups.set(group.state.id, group);
        group.emptySince = null;
        socket.data.groupId = group.state.id;
        group.state = {
          ...group.state,
          members: [
            ...group.state.members,
            { id: socket.data.id, displayName: principal.user.displayName },
          ],
        };
        await this.publish(group);
        this.directory();
      } else {
        const group = this.groups.get(socket.data.groupId ?? "");
        if (group === undefined) throw new Error("Join a watch group first");
        const previous = group.state;
        const details = Schema.decodeUnknownSync(IpcItemDetails)(
          await Effect.runPromise(
            this.services.catalog.itemDetails(principal, action.itemId, false, Date.now()),
          ),
        );
        await Effect.runPromise(
          this.services.access.requireLibrary(
            principal,
            details.item.libraryId,
            "playback:control",
            Date.now(),
          ),
        );
        if (socket.data.closed || socket.data.groupId !== group.state.id) return;
        if (group.state.revision !== previous.revision)
          throw new Error("Group changed. Try again.");
        if (action.type === "play") {
          if (details.item.kind === "show" || details.item.kind === "season")
            throw new Error("Choose a movie or episode");
          group.state = {
            ...group.state,
            revision: previous.revision + 1,
            playback: {
              itemId: action.itemId,
              title: details.item.title,
              paused: false,
              positionSeconds: action.positionSeconds,
              updatedAtMs: Date.now(),
            },
          };
        } else {
          const playback = previous.playback;
          if (playback === null || playback.itemId !== action.itemId)
            throw new Error("The group is watching something else");
          group.state = {
            ...group.state,
            revision: previous.revision + 1,
            playback:
              action.type === "stop"
                ? null
                : {
                    ...playback,
                    positionSeconds: action.positionSeconds,
                    paused: action.type === "pause" ? action.paused : playback.paused,
                    updatedAtMs: Date.now(),
                  },
          };
        }
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

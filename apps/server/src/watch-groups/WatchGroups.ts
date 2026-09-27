import {
  IpcItemDetails,
  WatchRequest,
  watchPosition,
  type WatchGroup,
  type WatchMessage,
} from "@lumen/contracts";
import { Effect, Schema } from "effect";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { HttpServices } from "../http/HttpApp";
import type { AuthPrincipal } from "../services/AuthService";
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
  passwordAttempts: number;
  closed: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
}
interface Group {
  state: WatchGroup;
  readonly passwordHash: string | null;
  emptySince: number | null;
}
const Authentication = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});

export class WatchGroups {
  private readonly sockets = new Set<ServerWebSocket<WatchSocketData>>();
  private readonly groups = new Map<string, Group>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly services: Pick<HttpServices, "auth" | "catalog" | "access">) {
    this.timer = setInterval(() => {
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
        passwordAttempts: 0,
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
        data.passwordAttempts = 0;
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

  private publish(group: Group): void {
    for (const socket of this.sockets) {
      if (socket.data.groupId === group.state.id)
        this.send(socket, { type: "state", group: group.state });
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
      this.publish(group);
      this.directory();
    }
    this.send(socket, { type: "state", group: null });
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
      const principal = await Effect.runPromise(
        this.services.auth.authenticate(socket.data.token, Date.now()),
      );
      if (socket.data.closed) return;
      socket.data.principal = principal;
      if (action.type === "ping") {
        this.send(socket, { type: "pong", sentAtMs: action.sentAtMs, serverTimeMs: Date.now() });
      } else if (action.type === "list") this.list(socket);
      else if (action.type === "leave") this.leave(socket);
      else if (action.type === "create" || action.type === "join") {
        if (++socket.data.passwordAttempts > 5)
          throw new Error("Too many attempts. Try again in a minute.");
        let group: Group;
        if (action.type === "create") {
          if (this.groups.size >= 64) throw new Error("Too many watch groups. Try again later.");
          const name = action.name.trim();
          if (name.length === 0) throw new Error("Enter a group name");
          const passwordHash = action.password === "" ? null : await hashPassword(action.password);
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
            !(await verifyPassword(action.password, group.passwordHash))
          )
            throw new Error("Incorrect group password");
          if (this.groups.get(action.groupId) !== group)
            throw new Error("This group is no longer available");
        }
        if (socket.data.closed) return;
        if (group.state.members.length >= 32) throw new Error("This group is full");
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
        this.publish(group);
        this.directory();
      } else {
        const group = this.groups.get(socket.data.groupId ?? "");
        if (group === undefined) throw new Error("Join a watch group first");
        const previous = group.state;
        if (action.type === "play") {
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
          if (group.state !== previous) throw new Error("Group changed. Try playing again.");
          if (details.item.kind === "show" || details.item.kind === "season")
            throw new Error("Choose a movie or episode");
          group.state = {
            ...previous,
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
            ...previous,
            revision: previous.revision + 1,
            playback:
              action.type === "stop"
                ? null
                : {
                    ...playback,
                    positionSeconds:
                      action.type === "seek" || action.type === "pause"
                        ? action.positionSeconds
                        : watchPosition(playback, Date.now()),
                    paused: action.type === "pause" ? action.paused : playback.paused,
                    updatedAtMs: Date.now(),
                  },
          };
        }
        this.publish(group);
      }
      this.send(socket, { type: "reply", requestId, error: null });
    } catch (cause) {
      this.send(socket, {
        type: "reply",
        requestId,
        error:
          cause instanceof Error && !cause.message.includes("\n")
            ? cause.message
            : "Watch group request failed",
      });
    }
  }
}

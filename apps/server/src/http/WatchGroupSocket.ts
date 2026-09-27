import { GroupClientFrame, type GroupErrorCode, type GroupServerFrame } from "@lumen/contracts";
import { Schema } from "effect";
import type { GroupRegistry } from "../features/watch-groups/GroupRegistry";
import { GroupFailure } from "../features/watch-groups/GroupFailure";
import { TokenBucket, type WatchGroupLimits } from "../features/watch-groups/WatchGroupLimits";

export interface WatchGroupSocketData {
  readonly id: string;
  readonly frames: TokenBucket;
  binding: { groupId: string; membershipId: string } | null;
  authenticating: boolean;
  closed: boolean;
  backpressured: boolean;
  pendingSnapshot: GroupServerFrame | null;
  authTimer: ReturnType<typeof setTimeout> | null;
}
export const makeWatchGroupSocket = (groups: GroupRegistry, limits: WatchGroupLimits) => {
  const sockets = new Set<Bun.ServerWebSocket<WatchGroupSocketData>>();
  let pending = 0;
  const close = (ws: Bun.ServerWebSocket<WatchGroupSocketData>, code: GroupErrorCode): void => {
    if (ws.data.closed) return;
    ws.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "membership-ended",
        code,
      } satisfies GroupServerFrame),
    );
    ws.close(4000, code);
  };
  const send = (ws: Bun.ServerWebSocket<WatchGroupSocketData>, frame: GroupServerFrame): void => {
    if (ws.data.closed) return;
    if (ws.data.backpressured && frame.type === "snapshot") {
      ws.data.pendingSnapshot = frame;
      return;
    }
    const result = ws.send(JSON.stringify(frame));
    if (result === 0 || ws.getBufferedAmount() > limits.backpressureBytes) {
      close(ws, "unavailable");
      return;
    }
    if (result === -1) ws.data.backpressured = true;
  };
  return {
    upgrade(request: Request, server: Bun.Server<WatchGroupSocketData>): Response | undefined {
      if (
        pending >= limits.unauthenticatedSockets ||
        sockets.size >= limits.groups * limits.members + limits.unauthenticatedSockets
      )
        return new Response("Watch group connection capacity reached", {
          status: 429,
          headers: { "retry-after": "5" },
        });
      pending++;
      const upgraded = server.upgrade(request, {
        data: {
          id: crypto.randomUUID(),
          frames: new TokenBucket(limits.framesPerSecond, limits.frameBurst, performance.now()),
          binding: null,
          authenticating: false,
          closed: false,
          backpressured: false,
          pendingSnapshot: null,
          authTimer: null,
        },
      });
      if (!upgraded) {
        pending--;
        return new Response("WebSocket upgrade required", { status: 400 });
      }
    },
    websocket: {
      data: {} as WatchGroupSocketData,
      maxPayloadLength: limits.frameBytes,
      backpressureLimit: limits.backpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: 20,
      open(ws) {
        sockets.add(ws);
        ws.data.authTimer = setTimeout(
          () => close(ws, "membership_expired"),
          limits.authenticationTimeoutMs,
        );
      },
      async message(ws, raw) {
        const receivedAt = performance.now();
        if (!ws.data.frames.take(receivedAt)) {
          close(ws, "rate_limited");
          return;
        }
        try {
          if (typeof raw !== "string" || Buffer.byteLength(raw) > limits.frameBytes)
            throw new Error("Invalid frame");
          const frame = Schema.decodeUnknownSync(GroupClientFrame)(JSON.parse(raw));
          if (frame.type === "authenticate") {
            if (ws.data.binding !== null || ws.data.authenticating)
              throw new Error("Already authenticated");
            ws.data.authenticating = true;
            const binding = await groups.attach(frame.ticket, {
              id: ws.data.id,
              send: (message) => send(ws, message),
              close: (code) => close(ws, code),
            });
            if (ws.data.closed) {
              await groups.detach(binding.groupId, binding.membershipId, ws.data.id);
              return;
            }
            ws.data.binding = binding;
            pending--;
            clearTimeout(ws.data.authTimer ?? undefined);
            ws.data.authTimer = null;
            return;
          }
          const binding = ws.data.binding;
          if (binding === null) throw new Error("Authenticate first");
          if (frame.type === "clock-ping") {
            send(ws, {
              protocolVersion: 1,
              type: "clock-pong",
              probeId: frame.probeId,
              serverInstanceId: groups.serverInstanceId,
              t1: receivedAt,
              t2: performance.now(),
            });
          } else if (frame.type === "command") {
            const result = await groups.command(
              binding.groupId,
              binding.membershipId,
              ws.data.id,
              frame.command,
            );
            send(ws, { protocolVersion: 1, type: "command-result", result });
          } else
            await groups.refresh(
              binding.groupId,
              binding.membershipId,
              ws.data.id,
              frame.type === "member-status" ? frame.status : undefined,
            );
        } catch (error) {
          const code = error instanceof GroupFailure ? error.groupCode : "invalid_command";
          if (ws.data.binding === null || code === "membership_expired") close(ws, code);
          else send(ws, { protocolVersion: 1, type: "error", code });
        }
      },
      drain(ws) {
        ws.data.backpressured = false;
        const frame = ws.data.pendingSnapshot;
        ws.data.pendingSnapshot = null;
        if (frame !== null) send(ws, frame);
      },
      close(ws) {
        if (ws.data.closed) return;
        ws.data.closed = true;
        sockets.delete(ws);
        clearTimeout(ws.data.authTimer ?? undefined);
        if (ws.data.binding === null) pending--;
        else
          void groups
            .detach(ws.data.binding.groupId, ws.data.binding.membershipId, ws.data.id)
            .catch(() => undefined);
        ws.data.pendingSnapshot = null;
      },
    } satisfies Bun.WebSocketHandler<WatchGroupSocketData>,
    dispose(): void {
      for (const ws of sockets) close(ws, "unavailable");
    },
  };
};

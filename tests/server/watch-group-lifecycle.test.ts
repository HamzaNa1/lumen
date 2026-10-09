import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  WATCH_CONNECTION_REPLACED,
  WATCH_MEMBER_TIMEOUT_MS,
  type WatchAction,
  type WatchGroup,
  type WatchMessage,
} from "../../packages/contracts/src/watch-groups.ts";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import type { AuthPrincipal } from "../../apps/server/src/services/AuthService";
import { WatchGroups, type WatchSocketData } from "../../apps/server/src/watch-groups/WatchGroups";
import { WatchGroupClient } from "../../packages/client/src/watch/WatchGroupClient";
import { eventually } from "../helpers/eventually";
import { watchFixture } from "../helpers/watch-groups";

type Services = ConstructorParameters<typeof WatchGroups>[0];
let fixture: Awaited<ReturnType<typeof watchFixture>>;
let principal: AuthPrincipal;
let details: unknown;
// Use real catalog data so playback commands exercise the same schema as production.
beforeAll(async () => {
  fixture = await watchFixture();
  const admin = await fixture.login();
  principal = {
    user: await admin.me(),
    sessionId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
  };
  details = await admin.itemDetails(fixture.itemId);
});
afterAll(async () => fixture.close());

const lifecycle = (overrides: Partial<Services> = {}) => {
  let now = 0;
  const groups = new WatchGroups(
    {
      auth: { authenticate: () => Effect.succeed(principal) },
      catalog: { itemDetails: () => Effect.succeed(details) },
      access: { requireLibrary: () => Effect.void },
      ...overrides,
    },
    undefined,
    { now: () => now },
  );
  const sockets: ServerWebSocket<WatchSocketData>[] = [];
  const open = () => {
    let data!: WatchSocketData;
    groups.upgrade(new Request("http://localhost/api/v1/watch-groups"), {
      upgrade: (_request: Request, options: { data: WatchSocketData }) => {
        data = options.data;
        return true;
      },
    } as unknown as Bun.Server<WatchSocketData>);
    const messages: WatchMessage[] = [];
    const closes: { code?: number; reason?: string }[] = [];
    const socket = {
      data,
      send: (raw: string) => {
        messages.push(JSON.parse(raw));
        return raw.length;
      },
      // Delay the close callback deliberately. Retirement must not depend on it.
      close: (code?: number, reason?: string) => {
        closes.push({ code, reason });
      },
    } as unknown as ServerWebSocket<WatchSocketData>;
    sockets.push(socket);
    groups.websocket.open?.(socket);
    const send = async (value: unknown) => {
      groups.websocket.message?.(socket, JSON.stringify(value));
      await socket.data.queue;
    };
    const action = (action: WatchAction) => send({ requestId: crypto.randomUUID(), action });
    const state = () => {
      const message = messages.findLast((message) => message.type === "state");
      return message?.type === "state" ? message.group : null;
    };
    return { socket, messages, closes, send, action, state };
  };
  const connect = async (
    token = "owner",
    clientId: string | undefined = crypto.randomUUID(),
    resumeGroupId?: string,
    readiness = true,
  ) => {
    const peer = open();
    await peer.send({ token, clientId, resumeGroupId, readiness, buffers: true });
    return peer;
  };
  return {
    groups,
    open,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => {
      groups.close();
      for (const socket of sockets) groups.websocket.close?.(socket, 1000, "");
    },
  };
};
const group = (state: WatchGroup | null): WatchGroup => {
  if (state === null) throw new Error("Missing test group");
  return state;
};

test("replacement atomically transfers the last readiness wait and discards old buffers", async () => {
  const life = lifecycle();
  try {
    const identity = crypto.randomUUID();
    const old = await life.connect("old", identity);
    const friend = await life.connect();
    await old.action({ type: "create", name: "Movie night", password: "" });
    const groupId = group(old.state()).id;
    await friend.action({ type: "join", groupId, password: "" });
    await old.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    const revision = group(old.state()).revision;
    await friend.action({ type: "ready", revision });
    await old.action({ type: "buffer", itemId: fixture.itemId, aheadSeconds: 30, toEnd: false });
    const before = friend.messages.length;
    const replacement = await life.connect("new", identity, groupId);
    await replacement.action({ type: "join", groupId, password: "" });
    expect(group(replacement.state())).toMatchObject({
      revision,
      playback: { paused: true, waitingFor: [replacement.socket.data.id] },
    });
    expect(group(replacement.state()).members).toHaveLength(2);
    expect(replacement.socket.data.buffer).toBeNull();
    expect(old.socket.data.closed).toBe(true);
    expect(old.closes).toEqual([
      { code: WATCH_CONNECTION_REPLACED, reason: "Watch connection replaced" },
    ]);
    expect(
      friend.messages
        .slice(before)
        .filter((message) => message.type === "state")
        .every((message) => message.group?.playback?.paused === true),
    ).toBe(true);
    // Late close and application messages from the old connection cannot release the new wait.
    life.groups.websocket.close?.(old.socket, 1000, "Late close");
    await old.action({ type: "ready", revision });
    await old.action({ type: "leave" });
    await friend.action({ type: "ping", sentAtMs: 0 });
    expect(group(friend.state()).playback?.waitingFor).toEqual([replacement.socket.data.id]);
    await replacement.action({ type: "ready", revision });
    await friend.action({ type: "ping", sentAtMs: 0 });
    expect(group(friend.state()).playback).toMatchObject({ paused: false, positionSeconds: 2 });
    expect(group(friend.state()).members).toHaveLength(2);
  } finally {
    life.close();
  }
});

test("a silent member expires while heartbeating slow viewers keep their own waits indefinitely", async () => {
  const life = lifecycle();
  try {
    const owner = await life.connect("owner", crypto.randomUUID(), undefined, false);
    const silent = await life.connect();
    const slow = await life.connect();
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = group(owner.state()).id;
    for (const peer of [silent, slow]) await peer.action({ type: "join", groupId, password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    const revision = group(owner.state()).revision;
    for (let elapsed = 0; elapsed < 3 * WATCH_MEMBER_TIMEOUT_MS; elapsed += 5000) {
      life.advance(5000);
      await owner.action({ type: "ping", sentAtMs: 0 });
      await slow.action({ type: "ping", sentAtMs: 0 });
      life.groups.sweep();
    }
    expect(silent.socket.data.closed).toBe(true);
    expect(silent.closes[0]?.reason).toBe("Watch client heartbeat expired");
    await owner.action({ type: "ping", sentAtMs: 0 });
    expect(group(owner.state())).toMatchObject({
      revision,
      playback: { paused: true, waitingFor: [slow.socket.data.id] },
    });
    expect(group(owner.state()).members).toHaveLength(2);
    expect(slow.socket.data.closed).toBe(false);
    await slow.action({ type: "ready", revision });
    await owner.action({ type: "ping", sentAtMs: 0 });
    expect(group(owner.state()).playback?.paused).toBe(false);
  } finally {
    life.close();
  }
});

test("logical client identities isolate independent clients, users and sessions", async () => {
  const otherUser = { ...principal, user: { ...principal.user, id: crypto.randomUUID() } };
  const otherSession = { ...principal, sessionId: crypto.randomUUID() };
  const life = lifecycle({
    auth: {
      authenticate: (token) =>
        Effect.succeed(
          token === "user" ? otherUser : token === "session" ? otherSession : principal,
        ),
    },
  });
  try {
    const identity = crypto.randomUUID();
    const owner = await life.connect("owner", identity);
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = group(owner.state()).id;
    const peers = [
      await life.connect("owner"),
      await life.connect("user", identity, groupId),
      await life.connect("session", identity, groupId),
      // An older handshake has no replacement identity, but still receives liveness expiry.
      await (async () => {
        const legacy = life.open();
        await legacy.send({ token: "legacy", readiness: true });
        return legacy;
      })(),
    ];
    for (const peer of peers) await peer.action({ type: "join", groupId, password: "" });
    await owner.action({ type: "ping", sentAtMs: 0 });
    expect(group(owner.state()).members).toHaveLength(5);
    expect([owner, ...peers].every((peer) => !peer.socket.data.closed)).toBe(true);
  } finally {
    life.close();
  }
});

test.each(["ready", "join", "play"] as const)(
  "late authentication and queued %s cannot mutate a replacement",
  async (type) => {
    const gate = Promise.withResolvers<void>();
    let gated = false;
    let waiting = false;
    const life = lifecycle({
      auth: {
        authenticate: (token) =>
          Effect.promise(async () => {
            if (token === "old" && gated) {
              waiting = true;
              await gate.promise;
            }
            return principal;
          }),
      },
    });
    try {
      const identity = crypto.randomUUID();
      const old = await life.connect("old", identity);
      await old.action({ type: "create", name: "Movie night", password: "" });
      const groupId = group(old.state()).id;
      await old.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
      const revision = group(old.state()).revision;
      const target = await life.connect("target");
      await target.action({ type: "create", name: "Other group", password: "" });
      gated = true;
      const pending = old.action(
        type === "ready"
          ? { type, revision }
          : type === "join"
            ? { type, groupId: group(target.state()).id, password: "" }
            : { type, itemId: fixture.itemId, positionSeconds: 99 },
      );
      const queued = old.action({ type: "leave" });
      await eventually(() => waiting);
      const replacement = await life.connect("new", identity, groupId);
      await replacement.action({ type: "join", groupId, password: "" });
      const before = group(replacement.state());
      gate.resolve();
      await Promise.all([pending, queued]);
      await replacement.action({ type: "ping", sentAtMs: 0 });
      expect(replacement.state()).toEqual(before);
      expect(old.socket.data.groupId).toBeNull();
      await target.action({ type: "ping", sentAtMs: 0 });
      expect(group(target.state()).members).toHaveLength(1);
    } finally {
      gate.resolve();
      life.close();
    }
  },
);

test.each([false, true])(
  "older upgrade's delayed handshake cannot reclaim a client (successor closed: %s)",
  async (closed) => {
    const gate = Promise.withResolvers<void>();
    let waiting = false;
    const life = lifecycle({
      auth: {
        authenticate: (token) =>
          Effect.promise(async () => {
            if (token === "old") {
              waiting = true;
              await gate.promise;
            }
            return principal;
          }),
      },
    });
    try {
      const identity = crypto.randomUUID();
      const old = life.open();
      const pending = old.send({ token: "old", clientId: identity, readiness: true });
      await eventually(() => waiting);
      const replacement = await life.connect("new", identity);
      await replacement.action({ type: "create", name: "Movie night", password: "" });
      if (closed) life.groups.websocket.close?.(replacement.socket, 1000, "Closed");
      gate.resolve();
      await pending;
      expect(old.socket.data.closed).toBe(true);
      expect(old.messages).toEqual([]);
      expect(replacement.closes).toEqual([]);
      expect(replacement.socket.data.closed).toBe(closed);
    } finally {
      gate.resolve();
      life.close();
    }
  },
);

test("late media access and visibility completions cannot release or control a replacement", async () => {
  const gate = Promise.withResolvers<void>();
  let gated = false;
  let waiting = false;
  const life = lifecycle({
    catalog: {
      itemDetails: () =>
        Effect.promise(async () => {
          if (gated) {
            waiting = true;
            await gate.promise;
          }
          return details;
        }),
    },
  });
  try {
    const identity = crypto.randomUUID();
    const old = await life.connect("old", identity);
    await old.action({ type: "create", name: "Movie night", password: "" });
    const groupId = group(old.state()).id;
    await old.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    gated = true;
    const pending = old.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 99 });
    await eventually(() => waiting);
    const replacement = await life.connect("new", identity, groupId);
    // Retirement is synchronous even though recipient access checks are still pending.
    expect(old.socket.data.closed).toBe(true);
    gated = false;
    gate.resolve();
    await pending;
    await replacement.action({ type: "ping", sentAtMs: 0 });
    expect(group(replacement.state()).playback).toMatchObject({
      positionSeconds: 2,
      paused: true,
      waitingFor: [replacement.socket.data.id],
    });
    expect(group(replacement.state()).members).toHaveLength(1);
  } finally {
    gate.resolve();
    life.close();
  }
});

const listen = (groups: WatchGroups) => {
  const sockets: ServerWebSocket<WatchSocketData>[] = [];
  let pongs = 0;
  const server = Bun.serve<WatchSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => groups.upgrade(request, server),
    websocket: {
      ...groups.websocket,
      open: (socket) => {
        sockets.push(socket);
        groups.websocket.open?.(socket);
      },
      pong: () => {
        pongs += 1;
      },
    },
  });
  return { server, sockets, pongs: () => pongs };
};

test("real transport pongs cannot keep an application-silent member in the readiness wait", async () => {
  const life = lifecycle();
  const transport = listen(life.groups);
  const { server } = transport;
  const owner = new WatchGroupClient(
    {
      serverOrigin: server.url.origin,
      watchAuthentication: () => ({ token: "owner" }),
    },
    () => undefined,
  );
  const url = new URL("/api/v1/watch-groups", server.url);
  url.protocol = "ws:";
  const silent = new WebSocket(url);
  const messages: WatchMessage[] = [];
  silent.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  try {
    owner.connect();
    await eventually(
      () => owner.status.connection === "connected" && silent.readyState === WebSocket.OPEN,
    );
    silent.send(JSON.stringify({ token: "silent", readiness: true, buffers: true }));
    await eventually(() => messages.some((message) => message.type === "ready"));
    await owner.action({ type: "create", name: "Transport pong", password: "" });
    const requestId = crypto.randomUUID();
    silent.send(
      JSON.stringify({
        requestId,
        action: { type: "join", groupId: owner.status.group?.id, password: "" },
      }),
    );
    await eventually(() =>
      messages.some((message) => message.type === "reply" && message.requestId === requestId),
    );
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    expect(owner.status.group?.playback?.waitingFor).toHaveLength(1);
    const silentSocket = transport.sockets.find((socket) => socket.data.readiness);
    if (silentSocket === undefined) throw new Error("Missing silent transport");
    silentSocket.ping("before");
    await eventually(() => transport.pongs() === 1);
    life.advance(WATCH_MEMBER_TIMEOUT_MS);
    await owner.action({ type: "ping", sentAtMs: Date.now() });
    silentSocket.ping("after");
    await eventually(() => transport.pongs() === 2);
    expect(silent.readyState).toBe(WebSocket.OPEN);
    life.groups.sweep();
    await eventually(
      () => silent.readyState === WebSocket.CLOSED && owner.status.group?.members.length === 1,
    );
    expect(owner.status.group?.playback).toMatchObject({ paused: false, positionSeconds: 2 });
    expect(owner.status.group?.playback?.waitingFor).toBeUndefined();
  } finally {
    owner.close();
    silent.close();
    life.close();
    await server.stop(true);
  }
});

test("a superseded shared client stops reconnecting instead of evicting its successor", async () => {
  const life = lifecycle();
  const { server, sockets } = listen(life.groups);
  const owner = new WatchGroupClient(
    {
      serverOrigin: server.url.origin,
      watchAuthentication: () => ({ token: "owner" }),
    },
    () => undefined,
  );
  let successor: WebSocket | undefined;
  try {
    owner.connect();
    await eventually(() => owner.status.connection === "connected");
    await owner.action({ type: "create", name: "Superseded", password: "" });
    const key = sockets[0]?.data.clientKey;
    if (key == null) throw new Error("Missing logical client identity");
    const identity = (JSON.parse(key) as string[])[2];
    const url = new URL("/api/v1/watch-groups", server.url);
    url.protocol = "ws:";
    successor = new WebSocket(url);
    await eventually(() => successor?.readyState === WebSocket.OPEN);
    successor.send(
      JSON.stringify({ token: "owner", clientId: identity, resumeGroupId: owner.status.group?.id }),
    );
    await eventually(() => owner.status.connection === "unavailable");
    owner.resume();
    owner.connect();
    expect(owner.status.error).toBe("Watch client connected elsewhere.");
    expect(owner.status.group).toBeNull();
    expect(owner.rejoining).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.data.closed).toBe(false);
  } finally {
    owner.close();
    successor?.close();
    life.close();
    await server.stop(true);
  }
});

test("expiry prevents a delayed join and its queued messages from resurrecting membership", async () => {
  const gate = Promise.withResolvers<void>();
  let gated = false;
  let waiting = false;
  const life = lifecycle({
    auth: {
      authenticate: (token) =>
        Effect.promise(async () => {
          if (token === "silent" && gated) {
            waiting = true;
            await gate.promise;
          }
          return principal;
        }),
    },
  });
  try {
    const owner = await life.connect("owner");
    await owner.action({ type: "create", name: "Expiry", password: "" });
    const groupId = group(owner.state()).id;
    const silent = await life.connect("silent");
    gated = true;
    const joining = silent.action({ type: "join", groupId, password: "" });
    const queued = silent.action({ type: "play", itemId: fixture.itemId, positionSeconds: 99 });
    await eventually(() => waiting);
    life.advance(WATCH_MEMBER_TIMEOUT_MS);
    await owner.action({ type: "ping", sentAtMs: 0 });
    life.groups.sweep();
    gate.resolve();
    await Promise.all([joining, queued]);
    await owner.action({ type: "ping", sentAtMs: 0 });
    expect(silent.socket.data.closed).toBe(true);
    expect(group(owner.state()).members).toHaveLength(1);
    expect(group(owner.state()).playback).toBeNull();
  } finally {
    gate.resolve();
    life.close();
  }
});

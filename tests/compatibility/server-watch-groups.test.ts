import { expect, test } from "bun:test";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import type { WatchStatus } from "@lumen/contracts";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { WatchGroupClient } from "../../packages/client/src/index.ts";
import { forbidden } from "../../apps/server/src/core/Errors";
import { WatchGroups, type WatchSocketData } from "../../apps/server/src/watch-groups/WatchGroups";
import { eventually, watchFixture } from "../helpers/watch-groups";

test("group membership does not grant control of media a user cannot access", async () => {
  const fixture = await watchFixture();
  try {
    const admin = await fixture.login();
    await admin.createUser({
      username: "guest",
      displayName: "Guest",
      password: "correct horse battery staple",
      role: "guest",
    });
    const owner = await fixture.connect(admin);
    const guest = await fixture.connect(await fixture.login("guest"));
    await owner.action({ type: "create", name: "Movie night", password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await guest.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
    expect(guest.status.group?.members).toHaveLength(2);
    expect(guest.status.group?.playback).toBeNull();
    await expect(
      guest.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 8 }),
    ).rejects.toThrow();
    expect(owner.status.group?.playback?.positionSeconds).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("visibility is checked for existing members, late joins, and revoked library grants", async () => {
  const fixture = await watchFixture();
  try {
    const admin = await fixture.login();
    const user = await admin.createUser({
      username: "guest",
      displayName: "Guest",
      password: "correct horse battery staple",
      role: "guest",
    });
    const guestServer = await fixture.login("guest");
    const guest = await fixture.connect(guestServer);
    const lateGuest = await fixture.connect(await fixture.login("guest"));
    const owner = await fixture.connect(admin);
    const discovery = await fixture.connect(await fixture.login("guest"));
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    await guest.action({ type: "join", groupId, password: "" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await guest.action({ type: "ping", sentAtMs: Date.now() });
    expect(guest.status.group?.playback).toBeNull();
    await lateGuest.action({ type: "join", groupId, password: "" });
    expect(lateGuest.status.group?.playback).toBeNull();
    await expect(guestServer.itemDetails(fixture.itemId)).rejects.toThrow();

    const grant = {
      id: crypto.randomUUID(),
      libraryId: fixture.libraryId,
      userId: user.id,
      role: "guest",
      capabilities: ["library:read"],
      canDownload: false,
      expiresAtMs: null,
    };
    const putGrant = (capabilities: string[]) =>
      admin.request(`/api/v1/libraries/${fixture.libraryId}/grants`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...grant, capabilities }),
      });
    await putGrant(["library:read"]);
    await discovery.action({ type: "list" });
    expect(discovery.status.groups.find((group) => group.id === groupId)?.playback).toMatchObject({ itemId: fixture.itemId, positionSeconds: 2 });
    await guest.action({ type: "ping", sentAtMs: Date.now() });
    await eventually(() => guest.status.group?.playback?.positionSeconds === 2);
    expect(guest.status.group?.playback).toMatchObject({
      itemId: fixture.itemId,
      positionSeconds: 2,
    });
    await expect(
      guest.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 9 }),
    ).rejects.toThrow();
    const revision = guest.status.group?.revision;
    await putGrant([]);
    await discovery.action({ type: "ping", sentAtMs: Date.now() });
    await eventually(() => discovery.status.groups.find((group) => group.id === groupId)?.playback === null);
    expect(discovery.status.groups.find((group) => group.id === groupId)?.playback).toBeNull();
    await guest.action({ type: "ping", sentAtMs: Date.now() });
    await eventually(() => guest.status.group?.playback === null);
    expect(guest.status.group?.revision).toBe(revision);
    expect(guest.status.group?.playback).toBeNull();
    expect(guest.status.group?.members).toHaveLength(3);
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 7 });
    await eventually(() => guest.status.group?.revision === owner.status.group?.revision);
    expect(guest.status.group?.playback).toBeNull();
    await putGrant(["library:read", "playback:control"]);
    await discovery.action({ type: "list" });
    expect(discovery.status.groups.find((group) => group.id === groupId)?.playback?.positionSeconds).toBe(7);
    await guest.action({ type: "ping", sentAtMs: Date.now() });
    await eventually(() => guest.status.group?.playback?.positionSeconds === 7);
    expect(guest.status.group?.playback?.positionSeconds).toBe(7);
    await guest.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 8 });
    await owner.action({ type: "ping", sentAtMs: Date.now() });
    expect(owner.status.group?.playback?.positionSeconds).toBe(8);
  } finally {
    await fixture.close();
  }
});

test("password-protected groups synchronize every member and initialize late joiners", async () => {
  const fixture = await watchFixture();
  try {
    const owner = await fixture.connect(await fixture.login());
    const viewer = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "together" });
    const groupId = owner.status.group?.id ?? "";
    await viewer.action({ type: "list" });
    expect(viewer.status.groups[0]?.hasPassword).toBe(true);
    await expect(viewer.action({ type: "join", groupId, password: "wrong" })).rejects.toThrow(
      "Incorrect group password",
    );
    expect(viewer.status.group).toBeNull();
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2.5 });
    await viewer.action({ type: "join", groupId, password: "together" });
    expect(viewer.status.group?.playback).toMatchObject({
      itemId: fixture.itemId,
      positionSeconds: 2.5,
      paused: false,
    });
    await viewer.action({
      type: "pause",
      itemId: fixture.itemId,
      paused: true,
      positionSeconds: 3,
    });
    await owner.action({ type: "ping", sentAtMs: Date.now() });
    expect(owner.status.group?.playback).toMatchObject({ paused: true, positionSeconds: 3 });
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 8.5 });
    await viewer.action({ type: "ping", sentAtMs: Date.now() });
    expect(viewer.status.group?.playback).toMatchObject({ paused: true, positionSeconds: 8.5 });
    await viewer.action({
      type: "pause",
      itemId: fixture.itemId,
      paused: false,
      positionSeconds: 8.5,
    });
    await owner.action({ type: "ping", sentAtMs: Date.now() });
    expect(owner.status.group?.playback?.paused).toBe(false);
    await viewer.action({ type: "stop", itemId: fixture.itemId });
    await owner.action({ type: "ping", sentAtMs: Date.now() });
    expect(owner.status.group?.playback).toBeNull();
    await viewer.action({ type: "leave" });
    expect(viewer.status.group).toBeNull();
    await owner.action({ type: "ping", sentAtMs: Date.now() });
    expect(owner.status.group?.members).toHaveLength(1);
    await expect(
      viewer.action({ type: "play", itemId: fixture.itemId, positionSeconds: 0 }),
    ).rejects.toThrow("Join a watch group first");
  } finally {
    await fixture.close();
  }
});

test("a rejected group switch preserves membership and stale media commands do not change state", async () => {
  const fixture = await watchFixture();
  try {
    const owner = await fixture.connect(await fixture.login());
    const viewer = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Private", password: "secret" });
    await viewer.action({ type: "create", name: "Public", password: "" });
    const groupId = viewer.status.group?.id ?? "";
    await expect(
      viewer.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "wrong" }),
    ).rejects.toThrow();
    expect(viewer.status.group?.id).toBe(groupId);
    await viewer.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await expect(
      viewer.action({ type: "seek", itemId: crypto.randomUUID(), positionSeconds: 7 }),
    ).rejects.toThrow();
    expect(viewer.status.group?.playback?.positionSeconds).toBe(2);
    await viewer.action({ type: "list" });
    expect(viewer.status.groups.find((group) => group.id === groupId)?.playback).toMatchObject({ itemId: fixture.itemId, positionSeconds: 2 });
  } finally {
    await fixture.close();
  }
});

test("revoked sessions are disconnected instead of remaining subscribed", async () => {
  const fixture = await watchFixture();
  try {
    const server = await fixture.login();
    const client = await fixture.connect(server);
    await client.action({ type: "create", name: "Movie night", password: "" });
    await server.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: server.currentSession?.sessionId }),
    });
    await expect(client.action({ type: "ping", sentAtMs: Date.now() })).rejects.toThrow(
      "disconnected",
    );
    expect(client.status.connection).toBe("offline");
  } finally {
    await fixture.close();
  }
});

test("slow recipient visibility checks coalesce state and cannot publish an older command afterward", async () => {
  const fixture = await watchFixture();
  const admin = await fixture.login();
  const user = await admin.me();
  const details = await admin.itemDetails(fixture.itemId);
  const principal = { user, sessionId: crypto.randomUUID(), deviceId: crypto.randomUUID() };
  const guestPrincipal = {
    ...principal,
    user: { ...user, id: crypto.randomUUID(), role: "guest" as const },
  };
  let releaseCheck: () => void = () => undefined;
  const check = new Promise<void>((resolve) => {
    releaseCheck = resolve;
  });
  let waiting = false;
  let checks = 0;
  let activeChecks = 0;
  let maximumChecks = 0;
  const groups = new WatchGroups({
    auth: {
      authenticate: (token) => Effect.succeed(token === "guest" ? guestPrincipal : principal),
    },
    catalog: {
      itemDetails: (viewer) =>
        Effect.promise(async () => {
          if (viewer.user.role === "guest") {
            checks += 1;
            activeChecks += 1;
            maximumChecks = Math.max(maximumChecks, activeChecks);
            waiting = true;
            await check;
            activeChecks -= 1;
          }
          return details;
        }),
    },
    access: { requireLibrary: () => Effect.void },
  });
  const server = Bun.serve<WatchSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => groups.upgrade(request, server),
    websocket: groups.websocket,
  });
  const clients: WatchGroupClient[] = [];
  const connect = async (
    token: string,
    onStatus: (status: WatchStatus) => void = () => undefined,
  ) => {
    const client = new ServerClient({ origin: server.url.toString() });
    const session = admin.currentSession;
    if (session === null) throw new Error("No test session");
    client.setSession({ ...session, accessToken: token });
    const watch = new WatchGroupClient(client, onStatus);
    clients.push(watch);
    watch.connect();
    await eventually(() => watch.status.connection === "connected");
    return watch;
  };
  try {
    const owner = await connect("owner");
    const controller = await connect("controller");
    const received: number[] = [];
    const directories: number[] = [];
    let lastGroup: WatchStatus["group"] = null;
    let lastDirectory: WatchStatus["groups"] = [];
    const guest = await connect("guest", (status) => {
      if (status.group !== lastGroup && status.group?.playback !== null && status.group !== null)
        received.push(status.group.revision);
      lastGroup = status.group;
      if (status.groups !== lastDirectory) {
        const group = status.groups.find((group) => group.playback !== null);
        if (group !== undefined && directories.at(-1) !== group.revision) directories.push(group.revision);
      }
      lastDirectory = status.groups;
    });
    await owner.action({ type: "create", name: "Movie night", password: "" });
    const groupId = owner.status.group?.id ?? "";
    await controller.action({ type: "join", groupId, password: "" });
    await guest.action({ type: "join", groupId, password: "" });
    const playing = owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await eventually(() => waiting);
    const seeking = controller.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 7 });
    await eventually(() => owner.status.group?.revision === 2);
    expect(guest.status.group?.playback).toBeNull();
    releaseCheck();
    await Promise.all([playing, seeking]);
    expect(guest.status.group?.playback?.positionSeconds).toBe(7);
    expect(received).toEqual([2]);
    await eventually(() => guest.status.groups[0]?.revision === 2);
    expect(directories).toEqual([2]);
    expect(maximumChecks).toBe(2);
    expect(checks).toBe(4);
  } finally {
    releaseCheck();
    for (const client of clients) client.close();
    groups.close();
    await server.stop(true);
    await fixture.close();
  }
});


test("discovery publishes playback changes only to viewers with current media access", async () => {
  const fixture = await watchFixture();
  try {
    const admin = await fixture.login();
    await admin.createUser({ username: "guest", displayName: "Guest", password: "correct horse battery staple", role: "guest" });
    const owner = await fixture.connect(admin);
    const viewer = await fixture.connect(await fixture.login());
    const guest = await fixture.connect(await fixture.login("guest"));
    await owner.action({ type: "create", name: "Movie night", password: "secret" });
    const groupId = owner.status.group?.id ?? "";
    const playback = () => viewer.status.groups.find((group) => group.id === groupId)?.playback;
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    await eventually(() => playback()?.positionSeconds === 2);
    expect(playback()).toMatchObject({ itemId: fixture.itemId, title: "Clip", paused: false });
    await guest.action({ type: "list" });
    expect(guest.status.groups.find((group) => group.id === groupId)?.playback).toBeNull();
    expect(guest.status.groups.find((group) => group.id === groupId)?.members).toHaveLength(1);
    expect(viewer.status.group).toBeNull();
    await owner.action({ type: "pause", itemId: fixture.itemId, positionSeconds: 3, paused: true });
    await eventually(() => playback()?.paused === true && playback()?.positionSeconds === 3);
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 8 });
    await eventually(() => playback()?.positionSeconds === 8);
    await owner.action({ type: "pause", itemId: fixture.itemId, positionSeconds: 8, paused: false });
    await eventually(() => playback()?.paused === false);
    await owner.action({ type: "stop", itemId: fixture.itemId });
    await eventually(() => playback() === null);
  } finally {
    await fixture.close();
  }
});


test.each([true, false])("slow discovery progresses under sustained updates without blocking authentication or heartbeat (media readable: %s)", async (readable) => {
  const fixture = await watchFixture();
  const admin = await fixture.login();
  const user = await admin.me();
  const details = await admin.itemDetails(fixture.itemId);
  const otherItemId = crypto.randomUUID();
  const principal = { user, sessionId: crypto.randomUUID(), deviceId: crypto.randomUUID() };
  const guestPrincipal = { ...principal, user: { ...user, id: crypto.randomUUID(), role: "guest" as const } };
  let gate = Promise.withResolvers<void>();
  let gated = true;
  let waiting = false;
  let activeChecks = 0;
  let maximumChecks = 0;
  const checkedItems: string[] = [];
  const groups = new WatchGroups({
    auth: { authenticate: (token) => Effect.succeed(token === "guest" ? guestPrincipal : principal) },
    catalog: {
      itemDetails: (viewer, itemId) => {
        const itemDetails = itemId === fixture.itemId
          ? details
          : { ...details, item: { ...details.item, id: otherItemId, title: "Restricted movie" } };
        if (viewer.user.role !== "guest") return Effect.succeed(itemDetails);
        return Effect.promise(async () => {
          activeChecks += 1;
          maximumChecks = Math.max(maximumChecks, activeChecks);
          checkedItems.push(itemId);
          try {
            if (gated) {
              waiting = true;
              await gate.promise;
            } else await Bun.sleep(150);
            return readable && itemId === fixture.itemId;
          } finally {
            activeChecks -= 1;
          }
        }).pipe(Effect.flatMap((allowed) => allowed ? Effect.succeed(itemDetails) : Effect.fail(forbidden())));
      },
    },
    access: { requireLibrary: () => Effect.void },
  });
  const server = Bun.serve<WatchSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => groups.upgrade(request, server),
    websocket: groups.websocket,
  });
  const clients: WatchGroupClient[] = [];
  const observedRevisions: number[] = [];
  let lastDirectory: WatchStatus["groups"] = [];
  let leaked = false;
  let watchedGroupId = "";
  const connect = async (token: string) => {
    const client = new ServerClient({ origin: server.url.toString() });
    const session = admin.currentSession;
    if (session === null) throw new Error("No test session");
    client.setSession({ ...session, accessToken: token });
    const watch = new WatchGroupClient(client, (status) => {
      if (token !== "guest" || status.groups === lastDirectory) return;
      lastDirectory = status.groups;
      const group = status.groups.find((group) => group.id === watchedGroupId);
      if (group !== undefined) observedRevisions.push(group.revision);
      if (group?.playback != null && (!readable || group.playback.itemId !== fixture.itemId)) leaked = true;
    });
    clients.push(watch);
    watch.connect();
    await eventually(() => watch.status.connection === "connected");
    return watch;
  };
  try {
    const owner = await connect("owner");
    await owner.action({ type: "create", name: "Movie night", password: "" });
    watchedGroupId = owner.status.group?.id ?? "";
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    const otherOwner = await connect("other-owner");
    await otherOwner.action({ type: "create", name: "Other group", password: "" });
    const guest = await connect("guest");
    await eventually(() => waiting);
    let pingFinished = false;
    void guest.action({ type: "ping", sentAtMs: Date.now() }).then(() => { pingFinished = true; });
    await eventually(() => pingFinished, 1000);
    let joined = false;
    void guest.action({ type: "join", groupId: otherOwner.status.group?.id ?? "", password: "" }).then(() => { joined = true; });
    await eventually(() => joined, 1000);
    expect(checkedItems).toEqual([fixture.itemId]);
    let listed = false;
    const listing = guest.action({ type: "list" }).then(() => { listed = true; });
    gated = false;
    gate.resolve();
    let updating = true;
    const updates = (async () => {
      for (let position = 3; position < 23; position += 1) {
        await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: position });
        await Bun.sleep(40);
      }
      updating = false;
    })();
    await eventually(() => listed, 1000);
    expect(updating).toBe(true);
    await eventually(() => observedRevisions.length >= 2, 1000);
    expect(updating).toBe(true);
    await Promise.all([updates, listing]);
    await eventually(() => guest.status.groups.find((group) => group.id === watchedGroupId)?.revision === owner.status.group?.revision);
    const playback = guest.status.groups.find((group) => group.id === watchedGroupId)?.playback;
    if (readable) expect(playback).toMatchObject({ itemId: fixture.itemId, positionSeconds: 22 });
    else expect(playback).toBeNull();

    await eventually(() => activeChecks === 0);
    gate = Promise.withResolvers<void>();
    gated = true;
    waiting = false;
    await owner.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 24 });
    await eventually(() => waiting);
    await owner.action({ type: "play", itemId: otherItemId, positionSeconds: 0 });
    gated = false;
    gate.resolve();
    await eventually(() => checkedItems.includes(otherItemId));
    await guest.action({ type: "list" });
    expect(guest.status.groups.find((group) => group.id === watchedGroupId)).toMatchObject({ revision: owner.status.group?.revision, playback: null });
    expect(leaked).toBe(false);
    expect(maximumChecks).toBe(1);
    expect(guest.status.connection).toBe("connected");
    expect(observedRevisions).toEqual([...observedRevisions].sort((left, right) => left - right));
  } finally {
    gate.resolve();
    for (const client of clients) client.close();
    groups.close();
    await server.stop(true);
    await fixture.close();
  }
});

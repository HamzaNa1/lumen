import { expect, test } from "bun:test";
import { watchFixture } from "../helpers/watch-groups";

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
    await expect(
      guest.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 8 }),
    ).rejects.toThrow();
    expect(owner.status.group?.playback?.positionSeconds).toBe(2);
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
    expect(viewer.status.groups.every((group) => group.playback === null)).toBe(true);
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

import { password } from "./support/server";
import { expect, test } from "./support/watch";

test("protected groups synchronize late joins and controls, reject stale commands, and clean up departures", async ({
  server,
  admin,
  connect,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const itemId = (await server.items(admin.accessToken, library.id))[0]?.id ?? "";
  const owner = await connect(admin.accessToken);
  const viewer = await connect((await server.login()).accessToken);
  await owner.action({ type: "create", name: "Film night", password: "secret" });
  const groupId = owner.status.group?.id ?? "";
  await viewer.action({ type: "list" });
  expect(viewer.status.groups).toEqual([
    expect.objectContaining({ id: groupId, hasPassword: true }),
  ]);
  await expect(viewer.action({ type: "join", groupId, password: "wrong" })).rejects.toThrow(
    "Incorrect group password",
  );
  expect(viewer.status.group).toBeNull();
  await owner.action({ type: "play", itemId, positionSeconds: 2 });
  await viewer.action({ type: "join", groupId, password: "secret" });
  expect(viewer.status.group?.playback).toMatchObject({
    itemId,
    positionSeconds: 2,
    paused: false,
  });
  await viewer.action({ type: "pause", itemId, positionSeconds: 3, paused: true });
  await expect
    .poll(() => owner.status.group?.playback)
    .toMatchObject({ positionSeconds: 3, paused: true });
  await owner.action({ type: "seek", itemId, positionSeconds: 8 });
  await expect
    .poll(() => viewer.status.group?.playback)
    .toMatchObject({ positionSeconds: 8, paused: true });
  const revision = owner.status.group?.revision;
  await viewer.action({ type: "play", itemId, positionSeconds: 0, replaces: crypto.randomUUID() });
  await owner.action({ type: "ping", sentAtMs: Date.now() });
  expect(owner.status.group?.revision).toBe(revision);
  await expect(
    viewer.action({ type: "seek", itemId: crypto.randomUUID(), positionSeconds: 1 }),
  ).rejects.toThrow();
  await viewer.action({ type: "stop", itemId });
  await expect.poll(() => owner.status.group?.playback).toBeNull();
  await viewer.action({ type: "leave" });
  expect(viewer.status.group).toBeNull();
  await expect.poll(() => owner.status.group?.members.length).toBe(1);
  await expect(viewer.action({ type: "play", itemId, positionSeconds: 0 })).rejects.toThrow(
    "Join a watch group first",
  );
  await owner.action({ type: "leave" });
  await viewer.action({ type: "list" });
  expect(viewer.status.groups).toEqual([]);
});

test("membership cannot disclose or control inaccessible media, and ACL changes affect connected members", async ({
  server,
  admin,
  connect,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const itemId = (await server.items(token, library.id))[0]?.id ?? "";
  const user = await server.api<{ id: string }>("/users", {
    token,
    body: { username: "viewer", displayName: "Viewer", password },
  });
  const owner = await connect(token);
  const viewer = await connect((await server.login("viewer")).accessToken);
  await owner.action({ type: "create", name: "Private media", password: "" });
  await owner.action({ type: "play", itemId, positionSeconds: 2 });
  await viewer.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
  expect(viewer.status.group?.playback).toBeNull();
  await expect(viewer.action({ type: "seek", itemId, positionSeconds: 8 })).rejects.toThrow();
  const grantId = crypto.randomUUID();
  const grant = async (capabilities: string[]) => {
    await server.api(`/libraries/${library.id}/grants`, {
      token,
      method: "PUT",
      body: {
        id: grantId,
        libraryId: library.id,
        userId: user.id,
        capabilities,
        canDownload: false,
        expiresAtMs: null,
      },
    });
    await viewer.action({ type: "ping", sentAtMs: Date.now() });
  };
  await grant(["library:read"]);
  await expect.poll(() => viewer.status.group?.playback).toMatchObject({ itemId });
  await expect(viewer.action({ type: "seek", itemId, positionSeconds: 8 })).rejects.toThrow();
  await grant(["library:read", "playback:control"]);
  await viewer.action({ type: "seek", itemId, positionSeconds: 8 });
  await expect.poll(() => owner.status.group?.playback?.positionSeconds).toBe(8);
  await grant([]);
  await expect.poll(() => viewer.status.group?.playback).toBeNull();
});

test("readiness and buffer starvation hold all members; stale readiness cannot release a newer seek", async ({
  server,
  admin,
  connect,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const itemId = (await server.items(admin.accessToken, library.id))[0]?.id ?? "";
  const owner = await connect(admin.accessToken, true);
  const viewer = await connect((await server.login()).accessToken, true);
  await owner.action({ type: "create", name: "Synchronized", password: "" });
  await viewer.action({ type: "join", groupId: owner.status.group?.id ?? "", password: "" });
  await owner.action({ type: "play", itemId, positionSeconds: 2 });
  await expect.poll(() => viewer.status.group?.playback?.waitingFor?.length).toBe(2);
  const revision = owner.status.group?.revision ?? -1;
  await owner.action({ type: "ready", revision });
  expect(owner.status.group?.playback?.paused).toBe(true);
  await viewer.action({ type: "ready", revision });
  await expect.poll(() => owner.status.group?.playback?.paused).toBe(false);
  await viewer.action({ type: "buffer", itemId, aheadSeconds: 6, toEnd: false });
  await expect
    .poll(() => owner.status.buffers)
    .toContainEqual({ memberId: viewer.status.memberId, aheadSeconds: 6, toEnd: false });
  await owner.action({ type: "seek", itemId, positionSeconds: 8 });
  await owner.action({ type: "ready", revision });
  expect(owner.status.group?.playback?.paused).toBe(true);
  await expect.poll(() => viewer.status.group?.revision).toBe(owner.status.group?.revision);
  const nextRevision = owner.status.group?.revision ?? -1;
  await owner.action({ type: "ready", revision: nextRevision });
  await viewer.action({ type: "ready", revision: nextRevision });
  await expect.poll(() => owner.status.group?.playback?.paused).toBe(false);
  await viewer.action({ type: "buffering", revision: owner.status.group?.revision ?? -1 });
  await expect.poll(() => owner.status.group?.playback?.paused).toBe(true);
  await viewer.action({ type: "leave" });
  await owner.action({ type: "ready", revision: owner.status.group?.revision ?? -1 });
  await expect.poll(() => owner.status.group?.playback?.paused).toBe(false);
});

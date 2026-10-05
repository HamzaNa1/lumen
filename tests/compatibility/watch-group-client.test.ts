import { expect, test } from "bun:test";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { eventually, watchFixture, watchProxy } from "../helpers/watch-groups";

const fixtureWithGroup = async () => {
  const fixture = await watchFixture();
  const owner = await fixture.connect(await fixture.login());
  await owner.action({ type: "create", name: "Movie night", password: "" });
  await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
  const viewer = await fixture.connect(await fixture.login());
  return { ...fixture, owner, viewer, groupId: owner.status.group?.id ?? "" };
};

test("an interrupted automatic rejoin preserves the desired protected group and catches up", async () => {
  const fixture = await watchFixture();
  const proxy = watchProxy(fixture.running.server.url);
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "together" });
    await owner.action({ type: "play", itemId: fixture.itemId, positionSeconds: 2 });
    const server = new ServerClient({ origin: proxy.origin });
    server.setSession((await fixture.login()).currentSession);
    const viewer = await fixture.connect(server);
    const groupId = owner.status.group?.id ?? "";
    await viewer.action({ type: "join", groupId, password: "together" });
    const memberId = viewer.status.memberId;
    proxy.interruptRejoin();
    await eventually(() => viewer.status.connection !== "connected");
    await owner.action({ type: "pause", itemId: fixture.itemId, paused: true, positionSeconds: 6 });
    await eventually(
      () =>
        viewer.status.connection === "connected" &&
        viewer.status.memberId !== memberId &&
        viewer.status.group?.playback?.positionSeconds === 6,
    );
    expect(viewer.status.group?.id).toBe(groupId);
    expect(viewer.status.group?.playback?.paused).toBe(true);
    expect(viewer.status.group?.members).toHaveLength(2);
  } finally {
    await proxy.close();
    await fixture.close();
  }
});

test("temporary server overload retries automatic rejoining without losing the group", async () => {
  const fixture = await watchFixture();
  const proxy = watchProxy(fixture.running.server.url);
  try {
    const owner = await fixture.connect(await fixture.login());
    await owner.action({ type: "create", name: "Movie night", password: "together" });
    const server = new ServerClient({ origin: proxy.origin });
    server.setSession((await fixture.login()).currentSession);
    const viewer = await fixture.connect(server);
    const groupId = owner.status.group?.id ?? "";
    await viewer.action({ type: "join", groupId, password: "together" });
    const oldMemberId = viewer.status.memberId;
    proxy.overloadRejoin();
    await eventually(() => viewer.status.connection !== "connected");
    await eventually(
      () => viewer.status.connection === "connected" && viewer.status.memberId !== oldMemberId,
    );
    await eventually(
      () =>
        viewer.status.group?.members.some((member) => member.id === viewer.status.memberId) ===
        true,
      2000,
    );
    expect(viewer.status.group?.id).toBe(groupId);
  } finally {
    await proxy.close();
    await fixture.close();
  }
});

test("a viewer's own actions show at once and settle on what the server says", async () => {
  const fixture = await fixtureWithGroup();
  try {
    const { owner, viewer, groupId } = fixture;
    await eventually(() => viewer.status.groups.some((group) => group.id === groupId));

    const joining = viewer.action({ type: "join", groupId, password: "" });
    expect(viewer.status.group).toBeNull();
    await joining;
    expect(viewer.status.group).toEqual(owner.status.group);

    const revision = viewer.status.group?.revision ?? 0;
    const pausing = viewer.action({
      type: "pause",
      itemId: fixture.itemId,
      paused: true,
      positionSeconds: 9,
    });
    expect(viewer.status.group).toMatchObject({
      revision: revision + 1,
      playback: { paused: true, positionSeconds: 9 },
    });
    await pausing;
    expect(viewer.status.group).toMatchObject({
      revision: revision + 1,
      playback: { paused: true, positionSeconds: 9 },
    });
    expect(viewer.status.group).toEqual(owner.status.group);

    const stopping = viewer.action({ type: "stop", itemId: fixture.itemId });
    expect(viewer.status.group?.playback).toBeNull();
    await stopping;
    expect(viewer.status.group).toEqual(owner.status.group);

    const leaving = viewer.action({ type: "leave" });
    expect(viewer.status.group).toBeNull();
    expect(viewer.rejoining).toBe(false);
    await leaving;
    expect(viewer.status.group).toBeNull();
  } finally {
    await fixture.close();
  }
});

test("an action the server refuses is withdrawn from what the viewer sees", async () => {
  const fixture = await watchFixture();
  try {
    const viewer = await fixture.connect(await fixture.login());
    const statuses: (string | null)[] = [];
    let refused = false;
    // Creating groups in quick succession runs into the server's limit on attempts.
    for (let attempt = 0; attempt < 30 && !refused; attempt += 1) {
      const before = viewer.status.group;
      const creating = viewer.action({ type: "create", name: `Group ${attempt}`, password: "" });
      expect(viewer.status.group?.name).toBe(`Group ${attempt}`);
      try {
        await creating;
        statuses.push(viewer.status.group?.name ?? null);
      } catch {
        refused = true;
        expect(viewer.status.group).toEqual(before);
      }
    }
    expect(refused).toBe(true);
    expect(statuses.at(-1)).toBe(`Group ${statuses.length - 1}`);
  } finally {
    await fixture.close();
  }
});

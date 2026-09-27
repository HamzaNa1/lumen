import { expect, test } from "bun:test";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { eventually, watchFixture, watchProxy } from "../helpers/watch-groups";

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

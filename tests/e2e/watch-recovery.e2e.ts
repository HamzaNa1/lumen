import { once } from "node:events";
import { WatchGroupClient } from "../../packages/client/src/index";
import { expect, test } from "./support/watch";
import { WatchProxy } from "./support/watch-proxy";

for (const authenticated of [false, true])
  test(`silent watch sockets expire through application deadlines, authenticated=${authenticated}`, async ({
    server,
    admin,
  }) => {
    const socket = new WebSocket(
      new URL("/api/v1/watch-groups", server.origin.replace(/^http/, "ws")),
    );
    let closure: CloseEvent | undefined;
    socket.addEventListener("close", (event) => {
      closure = event;
    });
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(5000) });
      if (authenticated) {
        const ready = once(socket, "message", { signal: AbortSignal.timeout(5000) });
        socket.send(JSON.stringify({ token: admin.accessToken }));
        expect(JSON.parse((await ready)[0].data)).toMatchObject({ type: "ready" });
        await server.advanceTime(30_001);
      }
      await expect.poll(() => closure).toBeDefined();
      expect(closure).toMatchObject(
        authenticated
          ? { code: 1001, reason: "Watch client heartbeat expired" }
          : { code: 1008, reason: "Authentication required" },
      );
    } finally {
      socket.close();
    }
  });

for (const interrupted of [false, true])
  test(`watch client catches up after a socket outage and interrupted handshake=${interrupted}`, async ({
    server,
    admin,
    connect,
  }) => {
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
    const itemId = (await server.items(admin.accessToken, library.id))[0]?.id ?? "";
    const owner = await connect(admin.accessToken);
    await owner.action({ type: "create", name: "Together", password: "secret" });
    await owner.action({ type: "play", itemId, positionSeconds: 2 });
    const proxy = await new WatchProxy(server.origin).start();
    const viewer = new WatchGroupClient(
      { serverOrigin: proxy.origin, watchAuthentication: () => ({ token: admin.accessToken }) },
      () => {},
    );
    try {
      viewer.connect();
      await expect.poll(() => viewer.status.connection).toBe("connected");
      await viewer.action({
        type: "join",
        groupId: owner.status.group?.id ?? "",
        password: "secret",
      });
      const memberId = viewer.status.memberId;
      proxy.interruptHello = interrupted;
      proxy.disconnect();
      await expect.poll(() => viewer.status.connection).not.toBe("connected");
      await owner.action({ type: "pause", itemId, paused: true, positionSeconds: 6 });
      await expect
        .poll(() => viewer.status.group?.playback, { timeout: 20000 })
        .toMatchObject({ paused: true, positionSeconds: 6 });
      await expect.poll(() => viewer.status.memberId).not.toBe(memberId);
      expect(viewer.status.group?.id).toBe(owner.status.group?.id);
      proxy.hold = true;
      const pausing = viewer.action({ type: "pause", itemId, paused: false, positionSeconds: 7 });
      expect(viewer.status.group?.playback).toMatchObject({ paused: false, positionSeconds: 7 });
      await expect.poll(() => proxy.pending.length).toBeGreaterThan(0);
      proxy.release();
      await pausing;
      await expect
        .poll(() => owner.status.group?.playback)
        .toMatchObject({ paused: false, positionSeconds: 7 });
      proxy.hold = true;
      await owner.action({ type: "pause", itemId, paused: true, positionSeconds: 8 });
      await owner.action({ type: "seek", itemId, positionSeconds: 9 });
      await expect.poll(() => proxy.pending.length).toBeGreaterThanOrEqual(2);
      proxy.release(true);
      await expect
        .poll(() => viewer.status.group?.playback)
        .toMatchObject({ paused: true, positionSeconds: 9 });
      proxy.hold = true;
      const leaving = viewer.action({ type: "leave" });
      expect(viewer.status.group).toBeNull();
      const lost = leaving.catch(() => {});
      proxy.disconnect();
      await lost;
      proxy.release();
      await expect.poll(() => viewer.status.connection, { timeout: 20000 }).toBe("connected");
      expect(viewer.status.group).toBeNull();
      expect(viewer.rejoining).toBe(false);
    } finally {
      viewer.close();
      await proxy.close();
    }
  });

test("unanswered watch commands expire, reconnect without replaying mutations, and reject commands after close", async ({
  server,
  admin,
}) => {
  const proxy = await new WatchProxy(server.origin).start();
  const viewer = new WatchGroupClient(
    { serverOrigin: proxy.origin, watchAuthentication: () => ({ token: admin.accessToken }) },
    () => {},
  );
  try {
    await expect(viewer.action({ type: "list" })).rejects.toThrow("not connected");
    viewer.connect();
    await expect.poll(() => viewer.status.connection).toBe("connected");
    await viewer.action({ type: "list" });
    const previousMember = viewer.status.memberId;
    proxy.hold = true;
    await expect(
      viewer.action({ type: "create", name: "Only once", password: "" }),
    ).rejects.toThrow("timed out");
    proxy.release();
    await expect
      .poll(
        () => viewer.status.connection === "connected" && viewer.status.memberId !== previousMember,
        { timeout: 20000 },
      )
      .toBe(true);
    await viewer.action({ type: "list" });
    expect(
      viewer.status.groups.filter((group) => group.name === "Only once").length,
    ).toBeLessThanOrEqual(1);
    expect(viewer.status.group).toBeNull();
    viewer.close();
    await expect(viewer.action({ type: "list" })).rejects.toThrow("not connected");
  } finally {
    viewer.close();
    await proxy.close();
  }
});

import { setInterval } from "node:timers/promises";
import { expect, test } from "./support/watch";

test("healthy group members keep their identities and playback across transport timeout windows", async ({
  server,
  admin,
  connect,
}) => {
  test.setTimeout(90_000);
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const itemId = (await server.items(admin.accessToken, library.id))[0]?.id ?? "";
  const owner = await connect(admin.accessToken, true);
  const viewer = await connect((await server.login()).accessToken, true);
  await owner.action({ type: "create", name: "Uninterrupted playback", password: "" });
  const groupId = owner.status.group?.id ?? "";
  await viewer.action({ type: "join", groupId, password: "" });
  await owner.action({ type: "play", itemId, positionSeconds: 2 });
  const revision = owner.status.group?.revision ?? -1;
  await owner.action({ type: "ready", revision });
  await viewer.action({ type: "ready", revision });
  await expect.poll(() => owner.status.group?.playback?.paused).toBe(false);
  await expect.poll(() => viewer.status.group?.playback?.paused).toBe(false);
  const clients = [owner, viewer];
  const memberIds = clients.map((client) => client.status.memberId);
  const playback = owner.status.group?.playback;
  const playingRevision = owner.status.group?.revision;
  const started = performance.now();
  // Real traffic and wall time exercise Bun's native socket timer, which a fake clock cannot.
  for await (const _ of setInterval(1000)) {
    await Promise.all(
      clients.map((client) => client.action({ type: "ping", sentAtMs: Date.now() })),
    );
    expect(clients.map((client) => client.status.memberId)).toEqual(memberIds);
    for (const client of clients) {
      expect(client.status.connection).toBe("connected");
      expect(client.status.group).toMatchObject({
        id: groupId,
        revision: playingRevision,
        playback,
      });
      expect(client.status.group?.members.map((member) => member.id).sort()).toEqual(
        [...memberIds].sort(),
      );
    }
    if (performance.now() - started >= 65_000) break;
  }
});

import { WatchGroupClient } from "../../packages/client/src/index";
import { connectDesktop, expect, test } from "./support/desktop";
import { mpvWire } from "./support/mpv-wire";
import { NetworkProxy } from "./support/proxy";

test.use({ mpvFaults: true });
for (const scenario of ["hold-speed", "fail-speed", "hold-sample", "disconnect"] as const)
  test(`real MPV synchronization survives ${scenario} during ${scenario === "hold-sample" ? "media replacement" : scenario === "disconnect" ? "network disconnection" : "group departure"}`, async ({
    server,
    admin,
    desktop,
  }) => {
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4", "Other.mp4"]);
    const items = await server.items(admin.accessToken, library.id);
    const film = items.find((item) => item.title === "Film")?.id ?? "";
    const other = items.find((item) => item.title === "Other")?.id ?? "";
    const owner = new WatchGroupClient(
      { serverOrigin: server.origin, watchAuthentication: () => ({ token: admin.accessToken }) },
      () => {},
      false,
    );
    const { page, app } = desktop;
    const wire = mpvWire(app);
    const proxy = await new NetworkProxy(server.origin).start();
    owner.connect();
    try {
      await expect.poll(() => owner.status.connection).toBe("connected");
      await owner.action({ type: "create", name: "Races", password: "" });
      await connectDesktop(page, proxy);
      const groupId = owner.status.group?.id ?? "";
      await page.evaluate(
        (groupId) => window.lumen.watch.action({ type: "join", groupId, password: "" }),
        groupId,
      );
      await owner.action({ type: "play", itemId: film, positionSeconds: 4 });
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.state()))
        .toMatchObject({ itemId: film, paused: false });
      await expect.poll(() => wire.command(["get_property", "time-pos"])).toBeGreaterThan(4.2);
      await wire.arm(scenario === "disconnect" ? "hold-speed" : scenario);
      if (scenario !== "hold-sample") await wire.command(["seek", 0.4, "relative+exact"]);
      await expect
        .poll(async () => (await wire.snapshot()).captured, { timeout: 15000 })
        .not.toBeNull();
      if (scenario === "hold-sample") {
        await owner.action({ type: "play", itemId: other, positionSeconds: 0, replaces: film });
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ itemId: other, paused: false });
        await wire.release();
        await expect.poll(() => wire.command(["get_property", "time-pos"])).toBeGreaterThan(0.1);
        expect(await wire.command(["get_property", "time-pos"])).toBeLessThan(3);
        expect(await wire.command(["get_property", "speed"])).toBe(1);
      } else {
        if (scenario === "fail-speed") {
          await expect
            .poll(
              async () =>
                (await wire.snapshot()).commands
                  .filter(
                    (entry) => entry.command[0] === "set_property" && entry.command[1] === "speed",
                  )
                  .slice(-1)[0]?.command[2],
            )
            .toBe(1);
          await wire.arm("hold-speed");
          await wire.command(["seek", 0.3, "relative+exact"]);
          await expect
            .poll(async () => (await wire.snapshot()).captured, { timeout: 15000 })
            .not.toBeNull();
        }
        const leaving =
          scenario === "disconnect"
            ? Promise.resolve()
            : page.evaluate(() => window.lumen.watch.action({ type: "leave" }));
        if (scenario === "disconnect") {
          proxy.disconnectWatch();
          await expect
            .poll(() => page.evaluate(async () => (await window.lumen.watch.state()).connection))
            .not.toBe("connected");
        } else await expect.poll(() => owner.status.group?.members.length).toBe(1);
        await wire.release();
        await leaving;
        await expect.poll(() => wire.command(["get_property", "speed"])).toBe(1);
        const speeds = (await wire.snapshot()).commands.filter(
          (entry) => entry.command[0] === "set_property" && entry.command[1] === "speed",
        );
        expect(speeds.at(-2)?.outcome).toBe("released");
        expect(speeds.at(-2)?.command[2]).not.toBe(1);
        expect(speeds.at(-1)?.command).toEqual(["set_property", "speed", 1]);
      }
    } finally {
      await wire.release();
      owner.close();
      await page.evaluate(() => window.lumen.player.stop());
      await proxy.close();
    }
  });

import { watchPosition } from "@lumen/contracts";
import { WatchGroupClient } from "../../packages/client/src/index";
import { connectDesktop, expect, test } from "./support/desktop";
import { mpvWire, type WireEntry } from "./support/mpv-wire";
import { NetworkProxy } from "./support/proxy";

const isSpeed = (entry: WireEntry) =>
  entry.command[0] === "set_property" && entry.command[1] === "speed";

const captureSpeed = async (
  wire: ReturnType<typeof mpvWire>,
  owner: WatchGroupClient,
  mode: "hold-speed" | "fail-speed",
) => {
  const playback = owner.status.group?.playback;
  expect(playback?.paused).toBe(false);
  if (!playback) throw new Error("Group playback is missing");
  const startedAtMs = Date.now();
  const attempt = await wire.disturb(mode, watchPosition(playback, owner.serverNow));
  await expect
    .poll(async () => (await wire.snapshot()).captured, {
      timeout: 8000,
      intervals: [25, 50, 100],
    })
    .toMatchObject({
      command: ["set_property", "speed", attempt.expectedSpeed],
      outcome: "held",
    });
  const captured = (await wire.snapshot()).captured;
  if (!captured) throw new Error("Speed fault was not captured");
  return { ...attempt, captured, startedAtMs };
};

test.use({ mpvFaults: true });
for (const scenario of ["hold-speed", "fail-speed", "hold-sample", "disconnect"] as const)
  test(
    scenario === "hold-sample"
      ? "a late MPV sample reply after media replacement leaves the new session intact"
      : `real MPV synchronization survives ${scenario} during ${scenario === "disconnect" ? "network disconnection" : "group departure"}`,
    async ({ server, admin, desktop }, testInfo) => {
      const library = await server.library(admin.accessToken, "movies", [], {
        "Film.mp4": "playback-sync.mp4",
        "Other.mp4": "playback-sync.mp4",
      });
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
      const timeline = () =>
        page.evaluate(() =>
          // Server compatibility also exercises an older released desktop without this export.
          typeof window.lumen.player.timeline === "function" ? window.lumen.player.timeline() : [],
        );
      owner.connect();
      try {
        await expect.poll(() => owner.status.connection).toBe("connected");
        await owner.action({ type: "create", name: "Races", password: "" });
        await connectDesktop(page, proxy);
        await expect
          .poll(() => page.evaluate(async () => (await window.lumen.watch.state()).connection))
          .toBe("connected");
        const groupId = owner.status.group?.id ?? "";
        await page.evaluate(
          (groupId) => window.lumen.watch.action({ type: "join", groupId, password: "" }),
          groupId,
        );
        await owner.action({ type: "play", itemId: film, positionSeconds: 1 });
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ itemId: film, paused: false });
        await expect.poll(() => wire.command(["get_property", "time-pos"])).toBeGreaterThan(1.2);
        if (scenario !== "hold-sample" && (await timeline()).length > 0) {
          // Wait for the controller to observe advancing playback after startup seeking.
          // A real clock may retain soft drift, which does not need to reach zero first.
          await expect
            .poll(async () => {
              const sample = (await timeline()).findLast(
                (event) =>
                  event.kind === "watch_synchronization" && event.fields.event === "drift_sample",
              );
              return sample?.fields.advancing === true && sample.fields.seek === false;
            })
            .toBe(true);
        }
        if (scenario === "hold-sample") {
          await wire.arm("hold-sample");
          await expect
            .poll(async () => (await wire.snapshot()).captured?.outcome, {
              timeout: 8000,
              intervals: [25, 50, 100],
            })
            .toBe("held");
          const captured = (await wire.snapshot()).captured;
          expect(captured?.command[0]).toBe("expand-text");
          await owner.action({ type: "play", itemId: other, positionSeconds: 0, replaces: film });
          await expect
            .poll(() => page.evaluate(() => window.lumen.player.state()), {
              timeout: 3000,
              intervals: [25, 50, 100],
            })
            .toMatchObject({ itemId: other, paused: false });
          const replacement = await page.evaluate(() => window.lumen.player.state());
          const beforeRelease = (await wire.snapshot()).commands.at(-1)?.id ?? 0;
          await wire.release();
          // Observe a successful sample on the new connection after delivery to the old socket.
          await expect
            .poll(async () =>
              (await wire.snapshot()).commands.some(
                (entry) =>
                  entry.id > beforeRelease &&
                  entry.connection !== captured?.connection &&
                  entry.command[0] === "expand-text" &&
                  entry.error === "success",
              ),
            )
            .toBe(true);
          expect(await page.evaluate(() => window.lumen.player.state())).toMatchObject({
            itemId: other,
            sessionId: replacement?.sessionId,
            paused: false,
          });
          expect(await wire.command(["get_property", "speed"])).toBe(1);
          expect(
            (await wire.snapshot()).commands.find((entry) => entry.id === captured?.id)?.outcome,
          ).toBe("released");
        } else {
          let initialCorrection: number | undefined;
          if (scenario === "disconnect") {
            // Exercise the previously missed case within an existing scenario, without another test.
            initialCorrection = (await captureSpeed(wire, owner, "hold-speed")).expectedSpeed;
            await wire.release();
            await expect
              .poll(() => wire.command(["get_property", "speed"]))
              .toBe(initialCorrection);
          }
          const { afterId, expectedSpeed, captured, startedAtMs } = await captureSpeed(
            wire,
            owner,
            scenario === "fail-speed" ? "fail-speed" : "hold-speed",
          );
          if (initialCorrection !== undefined) expect(expectedSpeed).not.toBe(initialCorrection);
          const diagnostics = await timeline();
          if (diagnostics.length) {
            const correction = diagnostics.findLast(
              (event) =>
                event.atMs >= startedAtMs &&
                event.kind === "watch_synchronization" &&
                event.fields.event === "drift_sample" &&
                event.fields.chosenSpeed === expectedSpeed,
            );
            expect(correction?.fields).toMatchObject({ advancing: true, seek: false });
            const drift = Number(correction?.fields.driftSeconds);
            expect(Math.abs(drift)).toBeGreaterThanOrEqual(0.15);
            expect(Math.abs(drift)).toBeLessThan(1);
            expect(Math.sign(drift)).toBe(Math.sign(expectedSpeed - 1));
          }
          if (scenario === "fail-speed") {
            const attempts = (await wire.snapshot()).commands.filter(
              (entry) => entry.id > afterId && entry.id < captured.id && isSpeed(entry),
            );
            const rejected = attempts.find((entry) => entry.outcome === "rejected");
            expect(rejected?.command).toEqual(["set_property", "speed", expectedSpeed]);
            expect(
              attempts.some(
                (entry) =>
                  entry.id > (rejected?.id ?? Infinity) &&
                  entry.command[2] === 1 &&
                  entry.error === "success",
              ),
            ).toBe(true);
          }
          const leaving =
            scenario === "disconnect"
              ? Promise.resolve()
              : page.evaluate(() => window.lumen.watch.action({ type: "leave" }));
          // Observe the transition while the write is held, before awaiting its queued reset.
          try {
            if (scenario === "disconnect") {
              proxy.disconnectWatch();
              await expect
                .poll(
                  () => page.evaluate(async () => (await window.lumen.watch.state()).connection),
                  { timeout: 2000, intervals: [25, 50, 100] },
                )
                .not.toBe("connected");
            } else
              await expect
                .poll(() => owner.status.group?.members.length, {
                  timeout: 2000,
                  intervals: [25, 50, 100],
                })
                .toBe(1);
          } finally {
            await wire.release();
            await leaving;
          }
          await expect.poll(() => wire.command(["get_property", "speed"])).toBe(1);
          const commands = (await wire.snapshot()).commands;
          expect(commands.find((entry) => entry.id === captured.id)).toMatchObject({
            outcome: "released",
            error: "success",
          });
          expect(commands.find((entry) => entry.id > captured.id && isSpeed(entry))).toMatchObject({
            command: ["set_property", "speed", 1],
            error: "success",
          });
        }
        expect(
          (await wire.snapshot()).expired,
          "No fault may outlive its four-second hold budget",
        ).toEqual([]);
      } finally {
        try {
          const evidence = await Promise.allSettled([
            wire.snapshot(),
            timeline(),
            page.evaluate(() => window.lumen.player.state()),
          ]);
          await testInfo.attach("sync race timeline", {
            body: JSON.stringify(
              { group: owner.status.group, serverNow: owner.serverNow, evidence },
              null,
              2,
            ),
            contentType: "application/json",
          });
        } finally {
          await wire.release();
          owner.close();
          await page.evaluate(() => window.lumen.player.stop());
          await proxy.close();
        }
      }
    },
  );

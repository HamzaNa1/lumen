import { watchPosition } from "@lumen/contracts";
import { WatchGroupClient } from "../../packages/client/src/index";
import { connectDesktop, expect, test } from "./support/desktop";
import { mpvWire, type WireEntry } from "./support/mpv-wire";
import { latch, NetworkProxy } from "./support/proxy";

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
  let startedAtMs = Date.now();
  let attempt = await wire.disturb(mode, watchPosition(playback, owner.serverNow));
  if (mode === "fail-speed") {
    const rejected = async () =>
      (await wire.snapshot()).commands.find(
        (entry) => entry.id > attempt.afterId && entry.outcome === "rejected",
      );
    await expect.poll(rejected).toMatchObject({
      command: ["set_property", "speed", attempt.expectedSpeed],
    });
    const failedId = (await rejected())?.id ?? Infinity;
    await expect
      .poll(async () =>
        (await wire.snapshot()).commands.find(
          (entry) => entry.id > failedId && isSpeed(entry) && entry.error === "success",
        ),
      )
      .toMatchObject({ command: ["set_property", "speed", 1] });
    await wire.release();
    const resumed = owner.status.group?.playback;
    if (!resumed) throw new Error("Group playback is missing after speed recovery");
    // Real playback can settle inside the deadband after the rejection; create a new drift.
    startedAtMs = Date.now();
    attempt = await wire.disturb("hold-speed", watchPosition(resumed, owner.serverNow));
  }
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
          // The replacement plays in the same MPV, so the late reply arrives where it now plays.
          await expect
            .poll(async () =>
              (await wire.snapshot()).commands.some(
                (entry) =>
                  entry.id > beforeRelease &&
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
          const commands = (await wire.snapshot()).commands;
          expect(commands.find((entry) => entry.id === captured?.id)?.outcome).toBe("released");
          expect(commands.findLast((entry) => entry.command[0] === "loadfile")?.connection).toBe(
            captured?.connection,
          );
          // An MPV that will not stop is replaced instead of waited on.
          await wire.arm("hold-stop");
          await owner.action({ type: "play", itemId: film, positionSeconds: 0, replaces: other });
          await expect
            .poll(
              async () => {
                const { captured, closed } = await wire.snapshot();
                return captured !== null && closed.includes(captured.connection);
              },
              { timeout: 3000, intervals: [25, 50, 100] },
            )
            .toBe(true);
          const stuck = (await wire.snapshot()).captured;
          expect(stuck?.command).toEqual(["stop"]);
          expect(stuck?.outcome).toBe("held");
          await wire.release();
          await expect
            .poll(() => page.evaluate(() => window.lumen.player.state()))
            .toMatchObject({ itemId: film, paused: false });
          expect(
            (await wire.snapshot()).commands.findLast((entry) => entry.command[0] === "loadfile")
              ?.connection,
          ).not.toBe(stuck?.connection);
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
          const { expectedSpeed, captured, startedAtMs } = await captureSpeed(
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

for (const recovery of ["resume", "exhaustion", "leave", "replace", "end", "runtime"] as const)
  test(`watch playback reloads unloaded media: ${recovery}`, async ({
    server,
    admin,
    desktop,
  }, testInfo) => {
    const library = await server.library(admin.accessToken, "movies", [], {
      "Film.mp4": "playback-sync.mp4",
      "Other.mp4": "playback-sync.mp4",
    });
    const items = await server.items(admin.accessToken, library.id);
    const itemId = items.find((item) => item.title === "Film")?.id ?? "";
    const other = items.find((item) => item.title === "Other")?.id ?? "";
    const owner = new WatchGroupClient(
      { serverOrigin: server.origin, watchAuthentication: () => ({ token: admin.accessToken }) },
      () => {},
      false,
    );
    const proxy = await new NetworkProxy(server.origin).start();
    const { page, app } = desktop;
    const wire = mpvWire(app);
    owner.connect();
    try {
      await expect.poll(() => owner.status.connection).toBe("connected");
      await owner.action({ type: "create", name: "Recovery", password: "" });
      await connectDesktop(page, proxy);
      await expect
        .poll(() => page.evaluate(async () => (await window.lumen.watch.state()).connection))
        .toBe("connected");
      await page.evaluate(
        (groupId) => window.lumen.watch.action({ type: "join", groupId, password: "" }),
        owner.status.group?.id ?? "",
      );
      await owner.action({ type: "play", itemId, positionSeconds: recovery === "end" ? 58 : 2 });
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.state()))
        .toMatchObject({ itemId, paused: false });
      const original = await page.evaluate(() => window.lumen.player.state());
      const group = owner.status.group;
      const member = (await page.evaluate(() => window.lumen.watch.state())).memberId;
      if (recovery === "end") {
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ ended: true });
        // A status refresh must not treat normal completion as a broken player.
        await page.evaluate(() => window.lumen.watch.action({ type: "list" }));
        await expect
          .poll(
            async () =>
              (await wire.snapshot()).commands.filter((entry) => entry.command[0] === "expand-text")
                .length,
          )
          .toBeGreaterThan(5);
        expect((await page.evaluate(() => window.lumen.watch.state())).error).toBeNull();
        expect((await page.evaluate(() => window.lumen.player.state()))?.sessionId).toBe(
          original?.sessionId,
        );
        await owner.action({ type: "seek", itemId, positionSeconds: 3 });
        await expect
          .poll(() => wire.command(["get_property", "time-pos"]).catch(() => Infinity))
          .toBeLessThan(10);
        return;
      }
      if (recovery === "runtime") {
        let sessionId = original?.sessionId;
        for (let failure = 0; failure < 4; failure++) {
          await wire.command(["quit"]).catch(() => undefined);
          if (failure < 3) {
            await expect
              .poll(
                async () => {
                  const state = await page.evaluate(() => window.lumen.player.state());
                  return state !== null && state.sessionId !== sessionId && !state.paused;
                },
                { timeout: 15000 },
              )
              .toBe(true);
            sessionId = (await page.evaluate(() => window.lumen.player.state()))?.sessionId;
          }
        }
        await expect
          .poll(async () => (await page.evaluate(() => window.lumen.watch.state())).error)
          .toContain("Retry playback");
        await page.evaluate(() => window.lumen.watch.retry());
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ itemId, paused: false });
        expect(
          (await page.evaluate(() => window.lumen.player.timeline())).some(
            (event) => event.kind === "playback_failure",
          ),
        ).toBe(true);
        expect((await page.evaluate(() => window.lumen.watch.state())).memberId).toBe(member);
        return;
      }
      let attempts = 0;
      const held = latch();
      const release = latch();
      proxy.intercept = async (request, response) => {
        if (request.method !== "POST" || request.url !== "/api/v1/playback/sessions") return false;
        attempts++;
        if (recovery === "exhaustion") {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ message: "Injected media outage" }));
          return true;
        }
        if (recovery === "leave" || recovery === "replace") {
          if (attempts === 1) {
            held.release();
            await release.promise;
          }
        }
        return false;
      };
      await wire.command(["stop"]);
      if (recovery === "exhaustion") {
        await expect
          .poll(async () => (await page.evaluate(() => window.lumen.watch.state())).error, {
            timeout: 15000,
          })
          .toContain("Retry playback");
        expect(attempts).toBe(3);
        // Move past every backoff deadline, then deliver another group status.
        const clock = await app.evaluateHandle(() => Date.now);
        try {
          await app.evaluate(() => {
            const now = Date.now;
            Date.now = () => now() + 60_000;
          });
          await page.evaluate(() => window.lumen.watch.action({ type: "list" }));
        } finally {
          await app.evaluate((_electron, now) => {
            Date.now = now;
          }, clock);
          await clock.dispose();
        }
        expect(attempts).toBe(3);
        proxy.intercept = async () => false;
        await page.evaluate(() => window.lumen.watch.retry());
      }
      if (recovery === "leave" || recovery === "replace") {
        try {
          await held.promise;
          if (recovery === "leave")
            await page.evaluate(() => window.lumen.watch.action({ type: "leave" }));
          else await owner.action({ type: "play", itemId: other, positionSeconds: 4 });
          if (recovery === "leave") {
            await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
            await expect
              .poll(async () => (await page.evaluate(() => window.lumen.watch.state())).group)
              .toBeNull();
          } else {
            await expect
              .poll(() => page.evaluate(() => window.lumen.player.state()))
              .toMatchObject({ itemId: other, paused: false });
            await expect.poll(() => wire.command(["get_property", "time-pos"])).toBeGreaterThan(4);
          }
        } finally {
          proxy.intercept = async () => false;
          release.release();
        }
        return;
      }
      await expect
        .poll(
          async () => {
            const state = await page.evaluate(() => window.lumen.player.state());
            return (
              state !== null &&
              state.sessionId !== original?.sessionId &&
              state.itemId === itemId &&
              !state.paused
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      await expect.poll(() => wire.command(["get_property", "time-pos"])).toBeGreaterThan(2);
      expect(owner.status.group?.revision).toBe(group?.revision);
      expect((await page.evaluate(() => window.lumen.watch.state())).memberId).toBe(member);
      await testInfo.attach("recovery-proof", {
        body: JSON.stringify(
          {
            before: original,
            after: await page.evaluate(() => window.lumen.player.state()),
            watch: await page.evaluate(() => window.lumen.watch.state()),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      try {
        await testInfo.attach("recovery-state", {
          body: JSON.stringify(
            await page.evaluate(async () => ({
              player: await window.lumen.player.state(),
              watch: await window.lumen.watch.state(),
              timeline: await window.lumen.player.timeline(),
            })),
            null,
            2,
          ),
          contentType: "application/json",
        });
      } finally {
        owner.close();
        await proxy.close();
      }
    }
  });

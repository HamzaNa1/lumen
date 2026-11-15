import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { connectDesktop, desktopPlayerPage, expect, test } from "./support/desktop";
import { mpvWire } from "./support/mpv-wire";
import { NetworkProxy } from "./support/proxy";
import { repository } from "./support/server";

test.use({ mpvFaults: true });
for (const kind of ["video", "audio", "both"] as const)
  test(`desktop falls back for an unavailable ${kind} decoder, seeks and closes converted playback`, async ({
    server,
    admin,
    desktop,
  }, testInfo) => {
    const library = await server.library(admin.accessToken, "movies", []);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      join(repository, "tests/fixtures/playback.mp4"),
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-map",
      "0:a",
      "-c:v",
      kind !== "audio" ? "mpeg4" : "libx264",
      "-c:a",
      kind !== "video" ? "ac3" : "aac",
      join(library.path, "Film.mkv"),
    ]);
    await server.scan(admin.accessToken, library.id);
    const proxy = await new NetworkProxy(server.origin).start();
    const { page, app } = desktop;
    try {
      await connectDesktop(page, proxy);
      const overlay = await desktopPlayerPage(app);
      await mpvWire(app).restrictDecoders(
        kind === "both"
          ? { video: "h264", audio: "aac" }
          : kind === "video"
            ? { video: "h264" }
            : { audio: "aac" },
      );
      await page.getByRole("link", { name: "movies", exact: true }).click();
      await page
        .getByRole("button", { name: "Play Film", exact: true })
        .first()
        .click({ force: true });
      const identity = await server.api<{ capabilities?: Record<string, boolean> }>("/server");
      if (!identity.capabilities?.transcoding) {
        await expect(overlay.getByText(/This server does not support transcoding/)).toBeVisible();
        expect(proxy.requests.some((request) => request.path.includes("transcode=1"))).toBe(false);
        return;
      }
      await expect
        .poll(() => proxy.requests.some((request) => request.path.includes("transcode=1")))
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.state()))
        .toMatchObject({ paused: false });
      const state = await page.evaluate(() => window.lumen.player.state());
      const sessionId = state?.sessionId ?? "";
      expect(await mpvWire(app).command(["get_property", "video-codec"])).toContain("264");
      expect(await mpvWire(app).command(["get_property", "audio-codec-name"])).toBe("aac");
      await page.evaluate((sessionId) => window.lumen.player.pause(sessionId, true), sessionId);
      await page.evaluate((sessionId) => window.lumen.player.seek(sessionId, 12), sessionId);
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.state()))
        .toMatchObject({ paused: true, positionSeconds: 12 });
      expect(proxy.requests.some((request) => request.path.includes("start=12"))).toBe(true);
      expect((await page.evaluate(() => window.lumen.player.state()))?.durationSeconds).toBe(20);
      const second = state?.streams.filter((stream) => stream.kind === "audio")[1];
      expect(second).toBeDefined();
      await page.evaluate(
        ({ sessionId, streamId }) => window.lumen.player.selectAudio(sessionId, streamId),
        { sessionId, streamId: second?.id ?? "" },
      );
      expect((await page.evaluate(() => window.lumen.player.state()))?.selectedAudioStreamId).toBe(
        second?.id,
      );
      expect(proxy.requests.some((request) => request.path.includes("audioIndex=1"))).toBe(true);
      await page.evaluate(async (sessionId) => {
        await Promise.allSettled([
          window.lumen.player.seek(sessionId, 4),
          window.lumen.player.seek(sessionId, 9),
        ]);
      }, sessionId);
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.state()))
        .toMatchObject({ paused: true, positionSeconds: 9 });

      if (kind === "both") {
        await page.evaluate((id) => window.lumen.player.pause(id, false), sessionId);
        await mpvWire(app).arm("hold-unpause");
        const seeking = page.evaluate((id) => window.lumen.player.seek(id, 6), sessionId);
        void seeking.catch(() => undefined);
        try {
          await expect
            .poll(async () => (await mpvWire(app).snapshot()).captured?.outcome)
            .toBe("held");
          await page.evaluate((id) => window.lumen.player.pause(id, true), sessionId);
        } finally {
          await mpvWire(app).release();
          await seeking;
        }
        expect(await mpvWire(app).command(["get_property", "pause"])).toBe(true);
        expect((await mpvWire(app).snapshot()).expired).toEqual([]);
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ paused: true });
        const conversions = () =>
          proxy.requests.filter((request) => request.path.includes("transcode=1")).length;
        const beforeResume = conversions();
        await mpvWire(app).command(["set_property", "ad", "not-a-decoder,-"]);
        await mpvWire(app).command(["set_property", "aid", "no"]);
        await mpvWire(app).command(["set_property", "aid", 1]);
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ paused: true });
        await page.evaluate((id) => window.lumen.player.pause(id, false), sessionId);
        expect(conversions()).toBeGreaterThan(beforeResume);
        expect(await mpvWire(app).command(["get_property", "audio-codec-name"])).toBe("aac");

        const first = state?.streams.find((stream) => stream.kind === "audio");
        if (!first) throw new Error("First audio stream is missing");
        const choices = () =>
          proxy.requests.filter((request) => request.path.endsWith("/track-choice")).length;
        const beforeChoice = choices();
        await mpvWire(app).arm("hold-unpause");
        const selecting = page.evaluate(
          ({ id, stream }) => window.lumen.player.selectAudio(id, stream),
          { id: sessionId, stream: first.id },
        );
        void selecting.catch(() => undefined);
        await expect
          .poll(async () => (await mpvWire(app).snapshot()).captured?.outcome)
          .toBe("held");
        const replacing = page.evaluate((id) => window.lumen.player.seek(id, 8), sessionId);
        void replacing.catch(() => undefined);
        try {
          await expect
            .poll(() => page.evaluate(() => window.lumen.player.state()))
            .toMatchObject({ positionSeconds: 8 });
        } finally {
          await mpvWire(app).release();
        }
        expect(
          (await Promise.allSettled([selecting, replacing])).map((result) => result.status),
        ).toEqual(["fulfilled", "fulfilled"]);
        expect(choices()).toBe(beforeChoice + 1);
        expect(
          (await page.evaluate(() => window.lumen.player.state()))?.selectedAudioStreamId,
        ).toBe(first.id);

        await mpvWire(app).arm("hold-unpause");
        const failingSeek = page.evaluate((id) => window.lumen.player.seek(id, 3), sessionId);
        void failingSeek.catch(() => undefined);
        try {
          await expect
            .poll(async () => (await mpvWire(app).snapshot()).captured?.outcome)
            .toBe("held");
          await mpvWire(app).command(["set_property", "ad", "not-a-decoder,-"]);
          await mpvWire(app).command(["set_property", "aid", "no"]);
          await mpvWire(app).command(["set_property", "aid", 1]);
        } finally {
          await mpvWire(app).release();
        }
        expect((await Promise.allSettled([failingSeek]))[0]?.status).toBe("rejected");
        await expect(overlay.getByText(/MPV could not decode the media/)).toBeVisible();
        expect((await mpvWire(app).snapshot()).expired).toEqual([]);
      }
      await page.evaluate(() => window.lumen.player.stop());
      await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
      await expect
        .poll(() =>
          proxy.requests.some(
            (request) => request.method === "DELETE" && request.path.endsWith(sessionId),
          ),
        )
        .toBe(true);
    } finally {
      await testInfo.attach("MPV playback commands", {
        body: JSON.stringify(await mpvWire(app).snapshot()),
        contentType: "application/json",
      });
      await proxy.close();
    }
  });

for (const scenario of ["disabled", "cancel", "runtime-disabled", "unsupported"] as const)
  test(`desktop ${scenario} conversion ends without repeated retries or an abandoned request`, async ({
    server,
    admin,
    desktop,
  }, testInfo) => {
    await server.library(admin.accessToken, "movies", [], {
      "Film.mkv": "playback-ac3.mkv",
    });
    const identity = await server.api<{ capabilities?: Record<string, boolean> }>("/server");
    if (scenario.includes("disabled") && identity.capabilities?.transcoding) {
      const settings = await server.api<Record<string, unknown>>("/admin/transcoding-settings", {
        token: admin.accessToken,
      });
      await server.api("/admin/transcoding-settings", {
        token: admin.accessToken,
        method: "PUT",
        body: { ...settings, enabled: false },
      });
    }
    const proxy = await new NetworkProxy(server.origin).start();
    let pending = false;
    let cancelled = false;
    if (scenario === "cancel")
      proxy.intercept = async (request, response) => {
        if (!request.url?.includes("transcode=1")) return false;
        pending = true;
        response.once("close", () => {
          cancelled = true;
        });
        return true;
      };
    if (scenario === "unsupported")
      proxy.intercept = async (request, response) => {
        if (request.url !== "/api/v1/server") return false;
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ...identity,
            capabilities: { ...identity.capabilities, transcoding: false },
          }),
        );
        return true;
      };
    const { page, app } = desktop;
    try {
      await connectDesktop(page, proxy);
      const overlay = await desktopPlayerPage(app);
      if (scenario !== "runtime-disabled") await mpvWire(app).restrictDecoders({ audio: "aac" });
      await page.getByRole("link", { name: "movies", exact: true }).click();
      await page
        .getByRole("button", { name: "Play Film", exact: true })
        .first()
        .click({ force: true });
      if (scenario === "runtime-disabled") {
        await expect
          .poll(() => page.evaluate(() => window.lumen.player.state()))
          .toMatchObject({ paused: false });
        expect(proxy.requests.some((request) => request.path.includes("transcode=1"))).toBe(false);
        await mpvWire(app).command(["set_property", "ad", "aac,-"]);
        await mpvWire(app).command(["set_property", "aid", "no"]);
        await mpvWire(app).command(["set_property", "aid", 1]);
      }
      if (!identity.capabilities?.transcoding || scenario === "unsupported") {
        await expect(overlay.getByText(/This server does not support transcoding/)).toBeVisible();
        expect(proxy.requests.some((request) => request.path.includes("transcode=1"))).toBe(false);
      } else if (scenario === "cancel") {
        await expect.poll(() => pending).toBe(true);
        await page.evaluate(() => window.lumen.player.stop());
        await expect.poll(() => cancelled, { timeout: 3000 }).toBe(true);
      } else {
        await expect(overlay.getByText(/Server transcoding is unavailable/)).toBeVisible();
        expect(
          (await mpvWire(app).snapshot()).commands.filter(
            (entry) => entry.command[0] === "loadfile",
          ),
        ).toHaveLength(2);
      }
      await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
      await expect
        .poll(() =>
          proxy.requests.some(
            (request) =>
              request.method === "DELETE" && request.path.includes("/playback/sessions/"),
          ),
        )
        .toBe(true);
    } finally {
      await testInfo.attach("MPV playback commands", {
        body: JSON.stringify(await mpvWire(app).snapshot()),
        contentType: "application/json",
      });
      await testInfo.attach("Media requests", {
        body: JSON.stringify(proxy.requests),
        contentType: "application/json",
      });
      await proxy.close();
    }
  });

test("desktop moves between the original and converted qualities, and between qualities without reloading", async ({
  server,
  admin,
  desktop,
}) => {
  // The released server a desktop release is checked against may predate converted qualities.
  const info = await server.api<{ capabilities?: Record<string, boolean> }>("/server");
  test.skip(info.capabilities?.adaptiveStreaming !== true, "The server predates qualities");
  const library = await server.library(admin.accessToken, "movies", []);
  execFileSync("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "40"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"],
    join(library.path, "Film.mkv"),
  ]);
  await server.scan(admin.accessToken, library.id);
  const proxy = await new NetworkProxy(server.origin).start();
  const { page, app } = desktop;
  try {
    await connectDesktop(page, proxy);
    await page.getByRole("link", { name: "movies", exact: true }).click();
    await page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    const state = () => page.evaluate(() => window.lumen.player.state());
    await expect.poll(state).toMatchObject({
      paused: false,
      quality: { choice: "auto", playing: "original" },
    });
    const sessionId = (await state())?.sessionId ?? "";
    expect((await state())?.quality?.options.map((option) => option.id)).toEqual([
      "original",
      "720p",
      "480p",
      "360p",
    ]);
    const choose = (choice: string) =>
      page.evaluate(
        ({ sessionId, choice }) => window.lumen.player.selectQuality(sessionId, choice),
        { sessionId, choice },
      );
    const height = () => mpvWire(app).command(["get_property", "video-params/h"]);
    const masters = () =>
      proxy.requests.filter((request) => request.path.includes("/master.m3u8")).length;

    // Leaving the original reloads MPV once, onto converted pieces.
    await choose("360p");
    await expect.poll(state).toMatchObject({ quality: { choice: "360p", playing: "360p" } });
    await expect.poll(height).toBe(360);
    expect(masters()).toBe(1);

    // The bridge holds 360p well ahead of the playhead.
    await expect
      .poll(async () => (await state())?.bufferedRanges.at(-1)?.endSeconds ?? 0)
      .toBeGreaterThanOrEqual(28);

    // A manual pick is never served a worse piece MPV has not read yet, even one already held, and
    // neither the pick nor a seek between converted pieces reloads MPV.
    await choose("720p");
    await page.evaluate((id) => window.lumen.player.seek(id, 24), sessionId);
    await expect.poll(height).toBe(720);
    await expect.poll(state).toMatchObject({ paused: false, quality: { playing: "720p" } });
    await expect.poll(async () => (await state())?.positionSeconds ?? 0).toBeGreaterThanOrEqual(24);
    expect(masters()).toBe(1);
    expect(proxy.requests.some((request) => /\/adaptive\/0\/720p\/6\.ts/u.test(request.path))).toBe(
      true,
    );

    await choose("original");
    await expect
      .poll(state)
      .toMatchObject({ quality: { choice: "original", playing: "original" } });
    await expect.poll(height).toBe(720);
    expect(masters()).toBe(1);
  } finally {
    await proxy.close();
  }
});

test("desktop Auto moves an original that stops arriving onto converted pieces and keeps playing", async ({
  server,
  admin,
  desktop,
}) => {
  const info = await server.api<{ capabilities?: Record<string, boolean> }>("/server");
  test.skip(info.capabilities?.adaptiveStreaming !== true, "The server predates qualities");
  const library = await server.library(admin.accessToken, "movies", []);
  const file = join(library.path, "Film.mkv");
  execFileSync("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "40"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", file],
  ]);
  await server.scan(admin.accessToken, library.id);
  const proxy = await new NetworkProxy(server.origin).start();
  // The original stops arriving a few seconds in, as on a link that cannot carry it.
  let allowance = Math.round(statSync(file).size * 0.1);
  proxy.intercept = async (request, response) => {
    if (request.method !== "GET" || !/^\/api\/v1\/media\/[^/?]+(?:\?|$)/u.test(request.url ?? ""))
      return false;
    const upstream = await fetch(new URL(request.url ?? "/", proxy.upstream), {
      headers: {
        authorization: request.headers.authorization ?? "",
        range: request.headers.range ?? "bytes=0-",
      },
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    for await (const chunk of upstream.body ?? []) {
      const part = Buffer.from(chunk).subarray(0, Math.max(0, allowance));
      allowance -= part.length;
      response.write(part);
      if (allowance <= 0) return true;
    }
    response.end();
    return true;
  };
  const { page } = desktop;
  try {
    await connectDesktop(page, proxy);
    await page.getByRole("link", { name: "movies", exact: true }).click();
    await page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    const state = () => page.evaluate(() => window.lumen.player.state());
    await expect.poll(state).toMatchObject({
      paused: false,
      quality: { choice: "auto", playing: "original" },
    });
    await expect.poll(async () => (await state())?.quality?.playing).toMatch(/^\d+p$/u);
    const switchedAt = (await state())?.positionSeconds ?? 0;
    expect((await state())?.quality?.choice).toBe("auto");
    await expect
      .poll(async () => (await state())?.positionSeconds ?? 0)
      .toBeGreaterThan(switchedAt + 2);
    expect(await state()).toMatchObject({ paused: false });
  } finally {
    await proxy.close();
  }
});

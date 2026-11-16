import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDesktop, desktopPlayerPage, expect, test } from "./support/desktop";
import { NetworkProxy } from "./support/proxy";
import { repository } from "./support/server";

test("real multitrack media exposes languages and roles and remembers independent choices after reopening", async ({
  server,
  admin,
  desktop,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", []);
  const subtitles = join(server.root, "subtitles.srt");
  await writeFile(subtitles, "1\n00:00:00,000 --> 00:00:19,000\nE2E subtitles\n");
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(repository, "tests/fixtures/playback.mp4"),
      "-i",
      subtitles,
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-map",
      "0:a",
      "-map",
      "0:a",
      "-map",
      "1:s",
      "-map",
      "1:s",
      "-c",
      "copy",
      "-metadata:s:a:0",
      "language=eng",
      "-metadata:s:a:1",
      "language=jpn",
      "-metadata:s:a:2",
      "language=eng",
      "-metadata:s:a:2",
      "title=Commentary",
      "-disposition:a:2",
      "comment",
      "-metadata:s:s:0",
      "language=eng",
      "-disposition:s:0",
      "forced",
      "-metadata:s:s:1",
      "language=eng",
      "-disposition:s:1",
      "hearing_impaired",
      join(library.path, "Tracks.mkv"),
    ],
    { timeout: 15000 },
  );
  await server.scan(token, library.id);
  const proxy = await new NetworkProxy(server.origin).start();
  let failSave = false;
  proxy.intercept = async (request, response) => {
    if (failSave && request.url?.endsWith("/track-choice")) {
      response
        .writeHead(503, { "content-type": "application/json" })
        .end('{"message":"Unavailable"}');
      return true;
    }
    return false;
  };
  try {
    await connectDesktop(desktop.page, proxy);
    await desktop.page.getByRole("link", { name: "movies", exact: true }).click();
    await desktop.page
      .getByRole("button", { name: "Play Tracks", exact: true })
      .first()
      .click({ force: true });
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({ paused: false });
    const state = await desktop.page.evaluate(() => window.lumen.player.state());
    expect(state?.streams).toHaveLength(5);
    const commentary = state?.streams.find((stream) => stream.commentary);
    const forced = state?.streams.find((stream) => stream.kind === "subtitle" && stream.forced);
    const sdh = state?.streams.find((stream) => stream.hearingImpaired);
    expect(commentary).toMatchObject({ language: "eng", codec: "aac" });
    expect(forced).toBeDefined();
    expect(sdh).toBeDefined();
    const sessionId = state?.sessionId ?? "";
    await desktop.page.evaluate(
      ({ sessionId, audio, subtitle }) =>
        Promise.all([
          window.lumen.player.selectAudio(sessionId, audio),
          window.lumen.player.selectSubtitle(sessionId, subtitle),
        ]),
      { sessionId, audio: commentary?.id ?? "", subtitle: forced?.id ?? "" },
    );
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({
        selectedAudioStreamId: commentary?.id,
        selectedSubtitleStreamId: forced?.id,
      });
    await desktop.page.evaluate(() => window.lumen.player.stop());
    await desktop.page.evaluate((itemId) => window.lumen.player.start(itemId), state?.itemId ?? "");
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({
        selectedAudioStreamId: commentary?.id,
        selectedSubtitleStreamId: forced?.id,
      });
    const current = await desktop.page.evaluate(() => window.lumen.player.state());
    await desktop.page.evaluate(
      (sessionId) => window.lumen.player.selectSubtitle(sessionId, null),
      current?.sessionId ?? "",
    );
    expect(current?.trackPreferences).toEqual({ audioLanguage: "en", subtitleLanguage: null });
    const english = current?.streams.find(
      (stream) => stream.kind === "audio" && stream.language === "eng" && !stream.commentary,
    );
    const overlay = await desktopPlayerPage(desktop.app);
    await overlay.getByRole("button", { name: "Playback settings", exact: true }).click();
    await overlay.getByRole("combobox", { name: "Audio track" }).click();
    const marked = overlay.getByRole("option", { name: / · Default$/ });
    await expect(marked).toHaveCount(1);
    await expect(marked).not.toContainText("Commentary");
    await marked.click();
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({ selectedAudioStreamId: english?.id, selectedSubtitleStreamId: null });
    // Picking the default follows the settings again rather than remembering English for this title.
    await server.api("/me/track-preferences", {
      token,
      method: "PATCH",
      body: { audioLanguage: "ja" },
    });
    await desktop.page.evaluate(() => window.lumen.player.stop());
    await desktop.page.evaluate((itemId) => window.lumen.player.start(itemId), state?.itemId ?? "");
    const japanese = state?.streams.find((stream) => stream.language === "jpn");
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({
        selectedAudioStreamId: japanese?.id,
        selectedSubtitleStreamId: null,
        trackPreferences: { audioLanguage: "ja", subtitleLanguage: null },
      });
    const reopened = await desktop.page.evaluate(() => window.lumen.player.state());
    failSave = true;
    await desktop.page.evaluate(({ id, audio }) => window.lumen.player.selectAudio(id, audio), {
      id: reopened?.sessionId ?? "",
      audio: commentary?.id ?? "",
    });
    expect(await desktop.page.evaluate(() => window.lumen.player.state())).toMatchObject({
      selectedAudioStreamId: commentary?.id,
      trackMemoryError: expect.stringContaining("Could not save"),
    });
    failSave = false;
    await desktop.page.evaluate(
      (id) => window.lumen.player.retryTrackMemory(id),
      reopened?.sessionId ?? "",
    );
    expect(await desktop.page.evaluate(() => window.lumen.player.state())).toMatchObject({
      trackMemoryError: null,
    });
    failSave = true;
    await desktop.page.evaluate(
      (id) => window.lumen.player.selectSubtitle(id, null),
      reopened?.sessionId ?? "",
    );
    await desktop.page.evaluate(
      (id) => window.lumen.player.dismissTrackMemoryError(id),
      reopened?.sessionId ?? "",
    );
    expect(await desktop.page.evaluate(() => window.lumen.player.state())).toMatchObject({
      trackMemoryError: null,
      selectedSubtitleStreamId: null,
    });
    await desktop.page.evaluate(() => window.lumen.player.stop());
  } finally {
    await proxy.close();
  }
});

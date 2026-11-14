import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDesktop, expect, test } from "../../tests/e2e/support/desktop";
import { median, slowLink } from "../slow-link";

// Times "next episode" in the real desktop app, from the action to MPV playing the episode.
// LUMEN_NEXT_EPISODE_MEDIA plays a file of your own; otherwise a 1080p Matroska file is made.
const rounds = Number(process.env.LUMEN_NEXT_EPISODE_ROUNDS ?? 8);
// A link to the server: each request waits this long for its answer, and bytes share this rate.
const rttMs = Number(process.env.LUMEN_NEXT_EPISODE_RTT_MS ?? 0);
const megabitsPerSecond = Number(process.env.LUMEN_NEXT_EPISODE_MBPS ?? 0);
const output = process.env.LUMEN_NEXT_EPISODE_OUTPUT ?? "";
const marks = [
  "playback_start",
  "session_started",
  "player_ready",
  "media_delivery",
  "playback_ready",
] as const;

test("next episode", async ({ server, admin, desktop }) => {
  test.setTimeout(900_000);
  const library = await server.library(admin.accessToken, "shows", []);
  const season = join(library.path, "Show", "Season 1");
  await mkdir(season, { recursive: true });
  let source = process.env.LUMEN_NEXT_EPISODE_MEDIA ?? "";
  if (source === "") {
    source = join(server.root, "episode.mkv");
    execFileSync("ffmpeg", [
      ...["-v", "error", "-y"],
      ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-t", "90", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "8M", "-g", "48"],
      ...["-c:a", "aac", "-b:a", "192k", source],
    ]);
  }
  for (let episode = 1; episode <= rounds + 1; episode += 1)
    await copyFile(source, join(season, `Show S01E${String(episode).padStart(2, "0")}.mkv`));
  await server.scan(admin.accessToken, library.id);
  const show = (await server.items(admin.accessToken, library.id)).find(
    (item) => item.kind === "show",
  );
  const { page } = desktop;
  const link =
    rttMs > 0 || megabitsPerSecond > 0
      ? await slowLink(server.origin, rttMs, megabitsPerSecond)
      : null;
  await connectDesktop(page, link ?? server);
  await page.evaluate((route) => {
    location.hash = route;
  }, `/show/${show?.id}`);
  await page
    .getByRole("button", { name: /^Play (Show S01E01|Episode 1)$/ })
    .first()
    .click({ force: true });
  const playingAfter = async (previous: string | null) => {
    let itemId: string | null = null;
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.lumen.player.state());
          const timeline = await page.evaluate(() => window.lumen.player.timeline());
          const ready = timeline.some((event) => event.kind === "playback_ready");
          itemId =
            state != null && state.itemId !== previous && !state.paused && ready
              ? state.itemId
              : null;
          return itemId;
        },
        { timeout: 60_000, intervals: [50] },
      )
      .not.toBeNull();
    return itemId;
  };
  let playing = await playingAfter(null);
  const inline = await page.evaluate(() => window.lumen.player.inline);
  const samples: Record<string, number>[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    // The next episode is known once its neighbours are looked up while this one plays.
    await expect
      .poll(() => page.evaluate(() => window.lumen.player.state()).then((s) => s?.positionSeconds))
      .toBeGreaterThan(2);
    // Watching most of an episode lets the player preload the next one. A build that cannot
    // never reports it, and moves on once the wait runs out.
    const current = await page.evaluate(() => window.lumen.player.state());
    await page.evaluate((id) => window.lumen.player.pause(id, true), current?.sessionId ?? "");
    await page.evaluate(({ id, at }) => window.lumen.player.seek(id, at), {
      id: current?.sessionId ?? "",
      at: Math.floor((current?.durationSeconds ?? 0) * 0.95),
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.lumen.player.timeline())).some(
            (event) => event.kind === "preload_finished",
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
      .catch(() => undefined);
    const requestedAtMs = await page.evaluate((inline) => {
      const at = Date.now();
      if (inline)
        document.querySelector<HTMLButtonElement>('button[aria-label="Next episode"]')?.click();
      else void window.lumen.player.overlayAction("next-episode");
      return at;
    }, inline);
    playing = await playingAfter(playing);
    const timeline = await page.evaluate(() => window.lumen.player.timeline());
    const sample: Record<string, number> = {};
    for (const mark of marks) {
      const event = timeline.find((entry) => entry.kind === mark);
      if (event !== undefined) sample[mark] = event.atMs - requestedAtMs;
    }
    samples.push(sample);
  }
  const summary = Object.fromEntries(
    marks.map((mark) => [mark, median(samples.map((sample) => sample[mark] ?? Number.NaN))]),
  );
  console.log(
    `median ms after "next episode" over ${rounds} rounds, rtt ${rttMs} ms, ${megabitsPerSecond || "unlimited"} Mbps:`,
    summary,
  );
  await link?.close();
  if (output !== "")
    await writeFile(
      output,
      JSON.stringify(
        { platform: process.platform, rttMs, megabitsPerSecond, summary, samples },
        null,
        2,
      ),
    );
});

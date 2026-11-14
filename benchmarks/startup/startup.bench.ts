import { execFileSync } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { connectDesktop, expect, test } from "../../tests/e2e/support/desktop";
import { median, slowLink } from "../slow-link";

// Times resuming a movie in the real desktop app with no player running: from the request to
// MPV playing at the resume position, and when each request for the file reached the server.
// LUMEN_STARTUP_MEDIA plays a file of your own; otherwise a 1080p Matroska file is made.
const rounds = Number(process.env.LUMEN_STARTUP_ROUNDS ?? 8);
// A link to the server: each request waits this long for its answer, and bytes share this rate.
const rttMs = Number(process.env.LUMEN_STARTUP_RTT_MS ?? 80);
const megabitsPerSecond = Number(process.env.LUMEN_STARTUP_MBPS ?? 50);
// Where playback resumes, as a share of the file's duration.
const resumeShare = Number(process.env.LUMEN_STARTUP_RESUME ?? 0.6);
const output = process.env.LUMEN_STARTUP_OUTPUT ?? "";
const marks = ["session_started", "player_ready", "media_delivery", "playback_ready"] as const;

test.use({ mpvFaults: true });

/** When MPV first plays at or past `seconds`, polled on its own socket. */
const playingAt = (app: ElectronApplication, seconds: number) =>
  app.evaluate(async (_electron, seconds) => {
    const wire = (
      globalThis as typeof globalThis & {
        __lumenMpvWire: { command(args: (string | number)[]): Promise<unknown> };
      }
    ).__lumenMpvWire;
    // A probe sent on the socket of the MPV that just quit is never answered.
    const probe = (name: string) =>
      Promise.race([
        Promise.resolve().then(() => wire.command(["get_property", name])),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("No answer")), 50)),
      ]);
    const deadline = Date.now() + 60_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const answers = await Promise.allSettled([
        probe("core-idle"),
        probe("seeking"),
        probe("time-pos"),
      ]);
      const [idle, seeking, position] = answers.map((answer) =>
        answer.status === "fulfilled" ? answer.value : null,
      );
      last = [idle, seeking, position];
      if (idle === false && seeking === false && typeof position === "number")
        if (position >= seconds) return Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`MPV never played the resume position: ${JSON.stringify(last)}`);
  }, seconds);

test("startup", async ({ server, admin, desktop }) => {
  test.setTimeout(900_000);
  const library = await server.library(admin.accessToken, "movies", []);
  let source = process.env.LUMEN_STARTUP_MEDIA ?? "";
  if (source === "") {
    source = join(server.root, "movie.mkv");
    execFileSync("ffmpeg", [
      ...["-v", "error", "-y"],
      ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-t", "600", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "6M", "-g", "48"],
      ...["-c:a", "aac", "-b:a", "192k", source],
    ]);
  }
  await copyFile(source, join(library.path, `Movie${source.slice(source.lastIndexOf("."))}`));
  await server.scan(admin.accessToken, library.id);
  const [movie] = await server.items(admin.accessToken, library.id);
  const durationSeconds = Number(
    execFileSync("ffprobe", [
      ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", source],
    ]).toString(),
  );
  const resumeSeconds = Math.floor(durationSeconds * resumeShare);
  const { page, app } = desktop;
  const link = await slowLink(server.origin, rttMs, megabitsPerSecond);
  await connectDesktop(page, link);
  const samples: Record<string, number>[] = [];
  const requests: { atMs: number; range: string | null }[][] = [];
  for (let round = 1; round <= rounds; round += 1) {
    await page.evaluate(() => window.lumen.player.stop());
    await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
    await server.api(`/items/${movie?.id}/watch-state`, {
      token: admin.accessToken,
      method: "PUT",
      body: { positionSeconds: resumeSeconds, completed: false },
    });
    await page.evaluate((route) => {
      location.hash = route;
    }, `/item/${movie?.id}`);
    await expect(page.getByRole("button", { name: /^Resume from/ })).toBeVisible();
    const before = link.sent.length;
    const requestedAtMs = await page.evaluate(() => {
      const resume = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Resume from"),
      );
      const requested = Date.now();
      resume?.click();
      return requested;
    });
    const playingAtMs = await playingAt(app, resumeSeconds);
    const timeline = await page.evaluate(() => window.lumen.player.timeline());
    const sample: Record<string, number> = { playing: playingAtMs - requestedAtMs };
    for (const mark of marks) {
      const event = timeline.findLast((entry) => entry.kind === mark);
      if (event !== undefined) sample[mark] = event.atMs - requestedAtMs;
    }
    samples.push(sample);
    requests.push(
      link.sent
        .slice(before)
        .filter((sent) => sent.range !== null && sent.atMs <= playingAtMs)
        .map((sent) => ({ atMs: sent.atMs - requestedAtMs, range: sent.range })),
    );
  }
  await page.evaluate(() => window.lumen.player.stop());
  const summary = Object.fromEntries(
    ["playing", ...marks].map((mark) => [
      mark,
      median(samples.map((sample) => sample[mark] ?? Number.NaN)),
    ]),
  );
  console.log(
    `median ms after resuming at ${resumeShare} over ${rounds} rounds, rtt ${rttMs} ms, ${megabitsPerSecond || "unlimited"} Mbps:`,
    summary,
    "\nrequests before playing, last round:",
    requests.at(-1),
  );
  await link.close();
  if (output !== "")
    await writeFile(
      output,
      JSON.stringify(
        {
          platform: process.platform,
          rttMs,
          megabitsPerSecond,
          resumeShare,
          summary,
          samples,
          requests,
        },
        null,
        2,
      ),
    );
});

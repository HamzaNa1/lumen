import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { connectDesktop, expect, test } from "../../tests/e2e/support/desktop";

// Plays generated clips in the real desktop app and measures what the viewer pays for video:
// time to the first frame, frames MPV dropped or showed late, frames the window presented,
// and CPU used by Electron, its helpers and the player. Run it on two builds to compare them.
// LUMEN_VIDEO_BENCH_MEDIA keeps generated clips between runs.
const rounds = Number(process.env.LUMEN_VIDEO_BENCH_ROUNDS ?? 3);
const seconds = Number(process.env.LUMEN_VIDEO_BENCH_SECONDS ?? 20);
const output = process.env.LUMEN_VIDEO_BENCH_OUTPUT ?? "";
const allClips = [
  { title: "Bench 1080p60", size: "1920x1080", rate: 60, bitrate: "12M" },
  { title: "Bench 2160p30", size: "3840x2160", rate: 30, bitrate: "25M" },
  { title: "Bench 2160p60", size: "3840x2160", rate: 60, bitrate: "40M" },
] as const;
// LUMEN_VIDEO_BENCH_CLIPS limits the run to clips whose titles contain one of its comma-separated parts.
const clipFilter = process.env.LUMEN_VIDEO_BENCH_CLIPS?.split(",") ?? [];
const clips = allClips.filter(
  (clip) => clipFilter.length === 0 || clipFilter.some((part) => clip.title.includes(part)),
);
const mpvCounters = [
  "frame-drop-count",
  "decoder-frame-drop-count",
  "mistimed-frame-count",
  "vo-delayed-frame-count",
] as const;

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const cpuSeconds = (time: string): number =>
  time
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);

/** CPU seconds used so far by a process and everything it spawned, by executable name. */
const treeCpu = (root: number): Record<string, number> => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/) ?? [])
    .map(([, pid, ppid, time, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      cpu: cpuSeconds(time ?? "0"),
      name: command?.split("/").at(-1) ?? "",
    }));
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (tree.has(row.ppid) && !tree.has(row.pid)) {
        tree.add(row.pid);
        grew = true;
      }
  }
  const byName: Record<string, number> = {};
  for (const row of rows)
    if (tree.has(row.pid)) byName[row.name] = (byName[row.name] ?? 0) + row.cpu;
  return byName;
};

const total = (cpu: Record<string, number>) =>
  Object.values(cpu).reduce((sum, value) => sum + value, 0);

/** Reads MPV's counters over its IPC socket, as a second client beside the app's own. */
const readCounters = (socket: string): Promise<Record<string, number>> =>
  new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    const values: Record<string, number> = {};
    let buffered = "";
    connection.on("error", reject);
    connection.on("connect", () => {
      mpvCounters.forEach((name, index) => {
        connection.write(
          `${JSON.stringify({ command: ["get_property", name], request_id: index + 1 })}\n`,
        );
      });
    });
    connection.on("data", (chunk) => {
      buffered += chunk.toString();
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, end)) as {
          request_id?: number;
          data?: unknown;
        };
        buffered = buffered.slice(end + 1);
        const name =
          message.request_id === undefined ? undefined : mpvCounters[message.request_id - 1];
        if (name !== undefined) values[name] = typeof message.data === "number" ? message.data : 0;
      }
      if (Object.keys(values).length === mpvCounters.length) {
        connection.end();
        resolve(values);
      }
    });
  });

test("video presentation", async ({ server, admin, desktop }) => {
  test.setTimeout(1_800_000);
  const media = process.env.LUMEN_VIDEO_BENCH_MEDIA ?? join(server.root, "bench-media");
  await mkdir(media, { recursive: true });
  for (const clip of clips) {
    const file = join(media, `${clip.title}.mkv`);
    if (existsSync(file)) continue;
    execFileSync("ffmpeg", [
      ...["-v", "error", "-y"],
      ...["-f", "lavfi", "-i", `testsrc2=size=${clip.size}:rate=${clip.rate}`],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-t", String(seconds + 20), "-c:v", "libx264", "-preset", "veryfast"],
      ...["-b:v", clip.bitrate, "-g", String(clip.rate * 2), "-pix_fmt", "yuv420p"],
      ...["-c:a", "aac", "-b:a", "192k", file],
    ]);
  }
  const library = await server.library(admin.accessToken, "movies", []);
  for (const clip of clips)
    await copyFile(join(media, `${clip.title}.mkv`), join(library.path, `${clip.title}.mkv`));
  await server.scan(admin.accessToken, library.id);
  const { page, app } = desktop;
  await connectDesktop(page, server);
  const electronPid = await app.evaluate(() => process.pid);
  const inline = await page.evaluate(() => window.lumen.player.inline);
  // The composited path reports each drawn frame back to the main process.
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { lumenPresented?: number };
    state.lumenPresented = 0;
    ipcMain.on("video:status", (_event, _generation, error) => {
      if (error === null) state.lumenPresented = (state.lumenPresented ?? 0) + 1;
    });
  });
  const presented = () =>
    app.evaluate(
      () => (globalThis as typeof globalThis & { lumenPresented?: number }).lumenPresented ?? 0,
    );
  const samples: Record<string, number | string>[] = [];
  for (let round = 1; round <= rounds; round += 1)
    for (const clip of clips) {
      await page.getByRole("link", { name: "movies", exact: true }).click();
      await page
        .getByRole("button", { name: `Play ${clip.title}`, exact: true })
        .first()
        .click();
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.state()), { timeout: 60_000 })
        .toMatchObject({ paused: false });
      // Playing again resumes where the last round stopped; measure every round from the start.
      await page.evaluate(async () => {
        const state = await window.lumen.player.state();
        if (state) await window.lumen.player.seek(state.sessionId, 0);
      });
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.lumen.player.state())?.positionSeconds ?? 99),
        )
        .toBeLessThan(1);
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.lumen.player.state())?.positionSeconds ?? 0),
        )
        .toBeGreaterThan(1);
      const timeline = await page.evaluate(() => window.lumen.player.timeline());
      const at = (kind: string) =>
        timeline.findLast((event) => event.kind === kind)?.atMs ?? Number.NaN;
      const sockets = (await readdir("/tmp")).filter((name) =>
        name.startsWith(`lumen-mpv-${electronPid}-`),
      );
      const socket = join("/tmp", sockets.toSorted().at(-1) ?? "");
      const before = {
        at: performance.now(),
        cpu: treeCpu(electronPid),
        counters: await readCounters(socket),
        presented: await presented(),
      };
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      const after = {
        at: performance.now(),
        cpu: treeCpu(electronPid),
        counters: await readCounters(socket),
        presented: await presented(),
      };
      const elapsed = (after.at - before.at) / 1000;
      samples.push({
        clip: clip.title,
        round,
        firstFrameMs: at("playback_ready") - at("playback_start"),
        cpuPercent: ((total(after.cpu) - total(before.cpu)) / elapsed) * 100,
        ...Object.fromEntries(
          Object.keys(after.cpu).map((name) => [
            `cpu ${name}`,
            (((after.cpu[name] ?? 0) - (before.cpu[name] ?? 0)) / elapsed) * 100,
          ]),
        ),
        ...(inline ? { presentedFps: (after.presented - before.presented) / elapsed } : {}),
        ...Object.fromEntries(
          mpvCounters.map((name) => [
            name,
            (after.counters[name] ?? 0) - (before.counters[name] ?? 0),
          ]),
        ),
      });
      await page.evaluate(() => window.lumen.player.stop());
      await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
      await page.evaluate(() => history.back());
    }
  const summary = Object.fromEntries(
    clips.map((clip) => {
      const own = samples.filter((sample) => sample.clip === clip.title);
      const keys = Object.keys(own[0] ?? {}).filter((key) => key !== "clip" && key !== "round");
      return [
        clip.title,
        Object.fromEntries(
          keys.map((key) => [key, median(own.map((sample) => Number(sample[key])))]),
        ),
      ];
    }),
  );
  console.log(`median over ${rounds} rounds of ${seconds}s:`, summary);
  if (output !== "")
    await writeFile(
      output,
      JSON.stringify(
        { platform: process.platform, inline, seconds, rounds, summary, samples },
        null,
        2,
      ),
    );
});
